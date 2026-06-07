import { Injectable } from "@nestjs/common";
import { createHash, createHmac } from "crypto";
import { Agent, Dispatcher, fetch, ProxyAgent } from "undici";
import { EnvService } from "./env.service";

type JsonRecord = Record<string, unknown>;

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
 * 火山引擎「智能处理 / 视频点播」画质增强（视频超分）封装。
 *
 * 鉴权使用火山引擎 V4 签名（HMAC-SHA256），自包含实现，无需额外 SDK。
 * Action 名 / Version / 请求字段在不同产品线（VOD / AI MediaKit）下不同，
 * 已全部做成 env 可配置；拿到 AK/SK 与准确接口文档后按需校正字段映射即可。
 */
@Injectable()
export class VolcEngineService {
  private readonly remoteDispatcher?: Dispatcher;
  private readonly directDispatcher = new Agent();

  constructor(private readonly env: EnvService) {
    if (env.proxyUrl) {
      this.remoteDispatcher = new ProxyAgent(env.proxyUrl);
    }
  }

  get configured() {
    return this.env.volcEnhanceConfigured;
  }

  /** 提交画质增强任务，返回火山任务 ID */
  async submitEnhanceTask(input: {
    videoUrl: string;
    targetResolution: string; // 1080p / 2k / 4k
    tier?: string; // standard / pro / turbo / llm
  }): Promise<EnhanceSubmitResult> {
    this.assertConfigured();

    const tier = input.tier || this.env.volcEnhanceTier;
    // 请求体字段为占位映射，按实际「提交画质增强任务 API」文档调整
    const body: JsonRecord = {
      InputVideoUrl: input.videoUrl,
      Tier: tier,
      TargetResolution: input.targetResolution,
      // 超分 + 插帧 + HDR 等可在此扩展，例如：EnableSR: true
    };

    const data = await this.signedRequest(this.env.volcEnhanceSubmitAction, body);

    const taskId = this.pick(data, ["TaskId", "Result.TaskId", "Data.TaskId", "Result.Data.TaskId"]);
    if (!taskId) {
      throw new Error(`火山提交画质增强任务未返回 TaskId: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return { taskId: String(taskId) };
  }

  /** 查询画质增强任务状态 */
  async queryEnhanceTask(taskId: string): Promise<EnhanceQueryResult> {
    this.assertConfigured();

    const body: JsonRecord = { TaskId: taskId };
    const data = await this.signedRequest(this.env.volcEnhanceQueryAction, body);

    const statusRaw = String(
      this.pick(data, ["Status", "Result.Status", "Data.Status", "Result.Data.Status"]) ?? "",
    ).toLowerCase();
    const outputVideoUrl = this.pick(data, [
      "OutputVideoUrl",
      "Result.OutputVideoUrl",
      "Data.OutputVideoUrl",
      "Result.OutputUrl",
      "Data.OutputUrl",
    ]) as string | undefined;

    const done = ["success", "succeeded", "completed", "finished", "done"].includes(statusRaw);
    const failed = ["failed", "error", "fail", "cancelled", "canceled"].includes(statusRaw);

    return { done, failed, status: statusRaw, outputVideoUrl, raw: data };
  }

  /** 下载结果视频为 Buffer（外部直链） */
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

  // ---------------- 内部：火山 V4 签名 ----------------

  private assertConfigured() {
    if (!this.configured) {
      throw new Error("未配置火山 AK/SK（VOLC_ACCESS_KEY / VOLC_SECRET_KEY），无法执行画质提升。");
    }
  }

  private async signedRequest(action: string, body: JsonRecord) {
    const host = this.env.volcEnhanceHost;
    const region = this.env.volcRegion;
    const service = this.env.volcEnhanceService;
    const version = this.env.volcEnhanceVersion;
    const accessKey = this.env.volcAccessKey!;
    const secretKey = this.env.volcSecretKey!;

    const method = "POST";
    const canonicalUri = "/";
    const query = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(version)}`;

    const payload = JSON.stringify(body);
    const payloadHash = this.hashHex(payload);

    const now = new Date();
    const xDate = this.toAmzDate(now); // YYYYMMDDTHHMMSSZ
    const shortDate = xDate.slice(0, 8);
    const contentType = "application/json";

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-content-sha256:${payloadHash}\n` +
      `x-date:${xDate}\n`;
    const signedHeaders = "content-type;host;x-content-sha256;x-date";

    const canonicalRequest = [
      method,
      canonicalUri,
      query,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${shortDate}/${region}/${service}/request`;
    const stringToSign = ["HMAC-SHA256", xDate, credentialScope, this.hashHex(canonicalRequest)].join("\n");

    const kDate = this.hmac(secretKey, shortDate);
    const kRegion = this.hmac(kDate, region);
    const kService = this.hmac(kRegion, service);
    const kSigning = this.hmac(kService, "request");
    const signature = this.hmac(kSigning, stringToSign).toString("hex");

    const authorization =
      `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `https://${host}${canonicalUri}?${query}`;
    console.log(`[VolcEngine] ${action} -> ${url} body=${payload.slice(0, 300)}`);

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": contentType,
        Host: host,
        "X-Date": xDate,
        "X-Content-Sha256": payloadHash,
        Authorization: authorization,
      },
      body: payload,
      dispatcher: this.dispatcherFor(url),
    } as any);

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`火山接口非 JSON 响应 (${response.status}): ${text.slice(0, 500)}`);
    }
    if (!response.ok || data?.ResponseMetadata?.Error) {
      throw new Error(`火山接口失败 (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  private hmac(key: string | Buffer, data: string) {
    return createHmac("sha256", key).update(data, "utf8").digest();
  }

  private hashHex(data: string) {
    return createHash("sha256").update(data, "utf8").digest("hex");
  }

  private toAmzDate(date: Date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  }

  /** 从可能嵌套的响应里按多个候选路径取第一个非空值 */
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

  private dispatcherFor(url: string) {
    if (!this.remoteDispatcher) return undefined;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const isLocal =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
      return isLocal ? this.directDispatcher : this.remoteDispatcher;
    } catch {
      return this.remoteDispatcher;
    }
  }
}
