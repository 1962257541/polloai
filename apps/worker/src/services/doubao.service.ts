import { Injectable } from "@nestjs/common";
import { Agent, Dispatcher, fetch, ProxyAgent } from "undici";
import { EnvService } from "./env.service";
import {
  CreateVideoInput,
  EnhancePromptInput,
  GenerateImageInput,
  GenerationProvider,
  ImageGenerationResult,
  VideoOperation,
} from "./generation-provider";

type JsonRecord = Record<string, unknown>;

/**
 * doubao-video-2api 自部署反代适配器（豆包 Seedance 免费视频）。
 *
 * 该服务把 doubao.com 的 Web 视频能力封装成 OpenAI 风格的「异步任务制」HTTP API：
 *   提交  POST {base}/v1/videos                 → { id, status, ... }
 *   轮询  GET  {base}/v1/videos/{id}            → { status: queued|in_progress|completed|failed, ... }
 *   下载  GET  {base}/v1/videos/{id}/content    → mp4 字节流（或 302 跳上游 CDN）
 *
 * 鉴权：Authorization: Bearer <API_MASTER_KEY>。base 取自账号配置的 apiUrl（如 http://doubao-2api:8088）。
 *
 * 与 apimart 的两点关键差异：
 *  1) 下载端点本身也挂了 verify_api_key，必须带 Bearer（apimart 拿到的是公网 CDN 直链，不带）；
 *  2) 纯视频服务——不支持图片生成，generateImage 直接抛错。
 */
@Injectable()
export class DoubaoService implements GenerationProvider {
  private readonly remoteDispatcher?: Dispatcher;
  private readonly directDispatcher = new Agent();

  // 豆包反代仅暴露一个视频模型；时长公开档位见其 VIDEO_LONG_FORM_PUBLIC_DURATION_OPTIONS
  private static readonly DEFAULT_MODEL = "doubao-seedance-2-0";
  private static readonly DURATION_OPTIONS = [5, 10, 15, 20, 25, 30];

  constructor(private readonly env: EnvService) {
    if (env.proxyUrl) {
      this.remoteDispatcher = new ProxyAgent(env.proxyUrl);
      console.log(`Doubao requests will use proxy: ${env.proxyUrl}`);
    }
  }

  // ── 图片：豆包反代不支持，保持接口一致但显式拒绝 ─────────────────────────
  async generateImage(_input: GenerateImageInput): Promise<ImageGenerationResult> {
    throw new Error("doubao 反代仅支持视频生成，请为图片任务改用 yunwu / apimart 供应商。");
  }

  // 无多模态提示词增强接口，直接返回原始 prompt
  async enhancePrompt(input: EnhancePromptInput): Promise<string> {
    return input.originalPrompt;
  }

  // ── 视频：仅提交，返回 task_id（轮询交给 worker 的 pollVideoCompletion）───
  async createVideoFromImage(input: CreateVideoInput): Promise<VideoOperation> {
    if (this.env.geminiMock) {
      console.log(`[MOCK][doubao] createVideoFromImage: prompt="${input.prompt.slice(0, 60)}"`);
      await this.sleep(1500);
      return { name: `mock-doubao-${Date.now()}`, done: false };
    }

    const base = this.apiBase(input.apiUrl);
    const references = this.mergeUrls(input.imageUrls, input.imageUrl);
    const size = input.size || (input.aspectRatio === "9:16" ? "720x1280" : "1280x720");
    const resolution = this.normalizeResolution(input.resolution);

    const body: JsonRecord = {
      model: input.model || DoubaoService.DEFAULT_MODEL,
      prompt: input.prompt,
      seconds: this.normalizeDuration(input.seconds),
      size,
      // 反代 OpenAI schema 用 resolution_name(720p/1080p)，内部转 resolution
      ...(resolution ? { resolution_name: resolution } : {}),
      // 豆包反代接受 input_reference: [{ image_url }]，多张参考图全部透传（反代会逐张上传并拼进豆包 ref_images）
      ...(references.length > 0 ? { input_reference: references.map((url) => ({ image_url: url })) } : {}),
    };

    console.log(`[doubao] video create body: ${JSON.stringify(body)}`);
    const submit = await this.postJson(`${base}/v1/videos`, body, input.apiKey);
    const taskId = this.extractTaskId(submit);
    console.log(`[doubao] video task submitted: ${taskId}`);
    return { name: taskId, done: false };
  }

  /** 单次查询任务状态，归一化为带 status 字段的对象，供 worker 的 pollVideoCompletion 判定 */
  async getVideo(operationName: string, apiKey: string, apiUrl?: string) {
    if (this.env.geminiMock) {
      await this.sleep(800);
      return { status: "completed", id: operationName, raw: {} };
    }

    const base = this.apiBase(apiUrl);
    const d = await this.getJson(`${base}/v1/videos/${encodeURIComponent(operationName)}`, apiKey);
    // OpenAI 风格状态：queued | in_progress | completed | failed
    let status = String(d?.status ?? "").toLowerCase();
    // worker 只认 completed/failed 为终态，其余继续轮询；统一映射为 running
    if (status === "in_progress" || status === "queued") status = "running";
    return {
      status,
      id: d?.id ?? operationName,
      error: d?.error,
      progress: d?.progress,
      raw: d,
    };
  }

  // 豆包反代视频无显式取消端点，保持与 Gemini/Apimart 一致的静默策略（取消由 DB 状态驱动）
  async cancelVideo(operationName: string, _apiKey: string, _apiUrl?: string): Promise<void> {
    console.warn(`[doubao] cancelVideo: no explicit cancel endpoint, skip task ${operationName}`);
  }

  async downloadVideo(data: any, apiKey: string, apiUrl?: string): Promise<Buffer> {
    if (this.env.geminiMock) {
      await this.sleep(500);
      return this.mockVideoBuffer();
    }

    const id = data?.id ?? data?.raw?.id;
    if (!id) {
      throw new Error(`doubao 视频结果缺少任务 id: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const base = this.apiBase(apiUrl);
    // ★ content 端点也挂了 verify_api_key，必须带 Bearer；跨域 302 跳上游 CDN 时 fetch 会自动剥离该头
    const downloaded = await this.downloadByUrl(`${base}/v1/videos/${encodeURIComponent(id)}/content`, apiKey, this.env.videoDownloadTimeoutMs);
    return downloaded.buffer;
  }

  // ── HTTP 封装 ───────────────────────────────────────────────────────────
  private async postJson(url: string, body: JsonRecord, apiKey: string) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        dispatcher: this.dispatcherFor(url),
      });
      return await this.parseJson(response, `POST ${url}`);
    } catch (error) {
      throw this.wrapFetchError(error, `POST ${url}`);
    }
  }

  private async getJson(url: string, apiKey: string) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        dispatcher: this.dispatcherFor(url),
      });
      return await this.parseJson(response, `GET ${url}`);
    } catch (error) {
      throw this.wrapFetchError(error, `GET ${url}`);
    }
  }

  private async parseJson(response: Awaited<ReturnType<typeof fetch>>, action: string) {
    const text = await response.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Doubao ${action} 非 JSON 响应 (${response.status}): ${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      throw new Error(`Doubao ${action} 失败 (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  private async downloadByUrl(
    url: string,
    apiKey: string,
    timeoutMs = 120_000,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        dispatcher: this.dispatcherFor(url),
        signal: AbortSignal.timeout(timeoutMs),
      } as any);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Doubao 下载失败 (${response.status}): ${text.slice(0, 300)}`);
      }
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: this.normalizeMimeType(response.headers.get("content-type") || ""),
      };
    } catch (error) {
      throw this.wrapFetchError(error, `GET ${url}`);
    }
  }

  // ── 解析与映射 ─────────────────────────────────────────────────────────
  private extractTaskId(submit: any): string {
    const id = submit?.id ?? submit?.task_id ?? submit?.data?.id;
    if (!id) {
      throw new Error(`Doubao 提交未返回任务 id: ${JSON.stringify(submit).slice(0, 500)}`);
    }
    return String(id);
  }

  private normalizeDuration(seconds?: number): number {
    if (seconds === undefined || seconds === null) return 10;
    return DoubaoService.DURATION_OPTIONS.reduce((best, option) =>
      Math.abs(option - seconds) < Math.abs(best - seconds) ? option : best,
    );
  }

  // 豆包 Seedance 仅支持 720p/1080p（反代 VIDEO_RESOLUTION_MAPPING）；非法值返回 undefined 用反代默认
  private normalizeResolution(resolution?: string): string | undefined {
    if (!resolution) return undefined;
    const value = resolution.trim().toLowerCase();
    return ["720p", "1080p"].includes(value) ? value : undefined;
  }

  private normalizeMimeType(value: string): string {
    return value.split(";")[0].trim().toLowerCase();
  }

  private mergeUrls(list?: string[], single?: string): string[] {
    return Array.from(
      new Set([...(list ?? []), ...(single ? [single] : [])].filter(Boolean)),
    );
  }

  // ── base 解析：取服务根（剥离用户可能误填的 /v1 后缀），端点统一拼 /v1/... ─
  private apiBase(apiUrl?: string): string {
    const raw = apiUrl ?? this.env.geminiBaseUrl;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`Doubao apiUrl 非法: ${raw}`);
    }
    let path = u.pathname.replace(/\/+$/, "");
    const idx = path.indexOf("/v1");
    if (idx >= 0) path = path.slice(0, idx);
    return `${u.protocol}//${u.host}${path}`;
  }

  // ── 代理调度（与 Gemini/Apimart 一致：内网直连，外网走代理）─────────────
  private dispatcherFor(url: string) {
    if (!this.remoteDispatcher) return undefined;
    return this.isLocalOrPrivateUrl(url) ? this.directDispatcher : this.remoteDispatcher;
  }

  private isLocalOrPrivateUrl(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".local")) {
        return true;
      }
      return (
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
      );
    } catch {
      return false;
    }
  }

  private wrapFetchError(error: unknown, action: string): Error {
    if (!(error instanceof Error)) {
      return new Error(`Doubao ${action} failed: ${String(error)}`);
    }
    const causeMessage =
      typeof error.cause === "object" && error.cause && "message" in error.cause
        ? String((error.cause as { message?: unknown }).message)
        : "";
    const proxyHint = this.env.proxyUrl
      ? `proxy=${this.env.proxyUrl}`
      : "no proxy configured; doubao 反代通常自部署在内网，确认 apiUrl 可达";
    return new Error(
      `Doubao ${action} failed: ${error.message}${causeMessage ? ` | cause=${causeMessage}` : ""} | ${proxyHint}`,
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mockVideoBuffer(): Buffer {
    const ftyp = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
      0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
    ]);
    const mdat = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74]);
    return Buffer.concat([ftyp, mdat]);
  }
}
