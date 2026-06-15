import { Injectable } from "@nestjs/common";
import { Agent, Dispatcher, fetch, ProxyAgent } from "undici";
import { EnvService } from "./env.service";
import { PrismaService } from "./prisma.service";

type JsonRecord = Record<string, unknown>;

/** 火山配置解析结果（DB 优先，回退 env）。 */
interface VolcResolvedConfig {
  apiKey: string;
  host: string;
  toolVersion: string;
  resolution: string;
}

export interface EnhanceSubmitResult {
  taskId: string;
}

export interface EnhanceQueryResult {
  done: boolean;
  failed: boolean;
  status: string;
  outputVideoUrl?: string;
  raw: unknown;
}

/**
 * 火山引擎 AI MediaKit「视频画质增强」封装。
 *
 * 鉴权：`Authorization: Bearer <MediaKit API Key>`（MEDIAKIT_ONLY，单密钥，非 V4 签名）。
 * 异步两步：提交 `POST /api/v1/tools/enhance-video` → 轮询 `GET /api/v1/tasks/{task_id}`。
 * 接口规格参考 bytedance/agentkit-samples · byted-mediakit-process-tools。
 */
@Injectable()
export class VolcEngineService {
  private readonly remoteDispatcher?: Dispatcher;
  private readonly directDispatcher = new Agent();

  constructor(
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
  ) {
    if (env.proxyUrl) {
      this.remoteDispatcher = new ProxyAgent(env.proxyUrl);
    }
  }

  /** API Key 是否已配置（DB 或 env 任一有值）。 */
  async isConfigured(): Promise<boolean> {
    const cfg = await this.resolveConfig();
    return Boolean(cfg.apiKey);
  }

  /**
   * 读取火山配置：SystemConfig 表（category="volc"）优先，回退 env 默认值。
   * 画质提升频率低，每次任务实时读取，无需缓存——保存即生效，无需重启 worker。
   */
  private async resolveConfig(): Promise<VolcResolvedConfig> {
    const rows = await this.prisma.systemConfig.findMany({ where: { category: "volc" } });
    const map = new Map(rows.map((r) => [r.key, r.valuePlain ?? ""]));
    const pick = (key: string, envVal: string | undefined) => {
      const v = map.get(key);
      return v && v.length > 0 ? v : envVal ?? "";
    };
    return {
      apiKey: pick("volc.apiKey", this.env.volcApiKey),
      host: pick("volc.host", this.env.volcHost),
      toolVersion: pick("volc.toolVersion", this.env.volcToolVersion),
      resolution: pick("volc.resolution", this.env.volcResolution),
    };
  }

  /** 提交画质增强任务，返回火山任务 ID。 */
  async submitEnhanceTask(input: {
    videoUrl: string;
    resolution?: string; // 240p~4k；缺省按 DB/env 配置兜底，仍为空则用原始分辨率
    toolVersion?: string; // standard | professional
  }): Promise<EnhanceSubmitResult> {
    const cfg = await this.resolveConfig();
    this.assertConfigured(cfg);

    const resolution = input.resolution || cfg.resolution;
    const body: JsonRecord = {
      video_url: input.videoUrl,
      tool_version: input.toolVersion || cfg.toolVersion || "standard",
      // resolution 留空 = 使用原始分辨率（不传该字段）
      ...(resolution ? { resolution } : {}),
    };

    const data = await this.request(cfg, "POST", "/api/v1/tools/enhance-video", body);

    const taskId = this.pick(data, ["task_id", "Result.task_id", "data.task_id"]);
    if (!taskId) {
      throw new Error(`火山提交画质增强任务未返回 task_id: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return { taskId: String(taskId) };
  }

  /** 查询画质增强任务状态。 */
  async queryEnhanceTask(taskId: string): Promise<EnhanceQueryResult> {
    const cfg = await this.resolveConfig();
    this.assertConfigured(cfg);

    const data = await this.request(cfg, "GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`);

    const status = String(this.pick(data, ["status", "data.status"]) ?? "").toLowerCase();
    const outputVideoUrl = this.pick(data, [
      "play_url",
      "data.play_url",
      "result.play_url",
      "output_url",
    ]) as string | undefined;

    // MediaKit 状态：running | queued | completed | failed | canceled
    const done = status === "completed";
    const failed = ["failed", "canceled", "cancelled", "timeout"].includes(status);

    return { done, failed, status, outputVideoUrl, raw: data };
  }

  /** 下载结果视频为 Buffer（外部直链）。 */
  async downloadResult(videoUrl: string): Promise<Buffer> {
    const response = await fetch(videoUrl, {
      method: "GET",
      dispatcher: this.dispatcherFor(videoUrl),
      signal: AbortSignal.timeout(120_000),
    } as any);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`火山结果视频下载失败 (${response.status}): ${text.slice(0, 300)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  // ---------------- 内部 ----------------

  private assertConfigured(cfg: VolcResolvedConfig) {
    if (!cfg.apiKey) {
      throw new Error("未配置火山 MediaKit API Key（系统设置→画质提升，或 VOLC_API_KEY），无法执行画质提升。");
    }
  }

  private async request(cfg: VolcResolvedConfig, method: "GET" | "POST", path: string, body?: JsonRecord) {
    const url = `https://${cfg.host}${path}`;
    const payload = body ? JSON.stringify(body) : undefined;
    console.log(`[VolcEngine] ${method} ${url}${payload ? ` body=${payload.slice(0, 300)}` : ""}`);

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload,
      dispatcher: this.dispatcherFor(url),
      signal: AbortSignal.timeout(60_000),
    } as any);

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`火山接口非 JSON 响应 (${response.status}): ${text.slice(0, 500)}`);
    }
    if (!response.ok || data?.success === false || data?.error) {
      throw new Error(`火山接口失败 (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  /** 从可能嵌套的响应里按多个候选路径取第一个非空值。 */
  private pick(obj: unknown, paths: string[]): unknown {
    for (const path of paths) {
      let cur: any = obj;
      let ok = true;
      for (const key of path.split(".")) {
        if (cur && typeof cur === "object" && key in cur) {
          cur = cur[key];
        } else {
          ok = false;
          break;
        }
      }
      if (ok && cur !== undefined && cur !== null && cur !== "") return cur;
    }
    return undefined;
  }

  /** 火山为国内节点（cn-beijing），强制直连不走科学上网代理。 */
  private dispatcherFor(url: string) {
    if (!this.remoteDispatcher) return undefined;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const isVolc = hostname.endsWith(".volces.com") || hostname.endsWith(".volcvideo.com") || hostname.endsWith(".volcengineapi.com");
      const isLocal =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
      return isVolc || isLocal ? this.directDispatcher : this.remoteDispatcher;
    } catch {
      return this.remoteDispatcher;
    }
  }
}
