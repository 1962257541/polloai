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
 * apib.ai（APIMart 平台）适配器。
 *
 * 与 yunwu 不同，图片与视频统一为「异步任务制」：
 *   提交  POST {base}/images/generations | {base}/videos/generations  → { data:[{ task_id }] }
 *   轮询  GET  {base}/tasks/{task_id}?language=zh                      → { data:{ status, result } }
 *   结果  result.images[].url[]（图片） / result.videos[]（视频）
 *
 * 鉴权：Authorization: Bearer <apiKey>。base 取自用户账号配置的 apiUrl（如 https://api.apib.ai/v1）。
 *
 * 图片轮询在本服务内部完成（worker 图片流为同步语义）；
 * 视频仅做提交并返回 task_id，由 worker 的 pollVideoCompletion 统一轮询（以支持取消/进度落库）。
 */
@Injectable()
export class ApimartService implements GenerationProvider {
  private readonly remoteDispatcher?: Dispatcher;
  private readonly directDispatcher = new Agent();

  // 图片任务轮询参数
  private static readonly IMAGE_POLL_INTERVAL_MS = 3000;
  private static readonly IMAGE_POLL_TIMEOUT_MS = 300_000;

  constructor(private readonly env: EnvService) {
    if (env.proxyUrl) {
      this.remoteDispatcher = new ProxyAgent(env.proxyUrl);
      console.log(`APIMart requests will use proxy: ${env.proxyUrl}`);
    }
  }

  // ── 图片：提交 + 内部轮询，返回成品 buffer ──────────────────────────────
  async generateImage(input: GenerateImageInput): Promise<ImageGenerationResult> {
    if (this.env.geminiMock) {
      console.log(`[MOCK][apimart] generateImage: prompt="${input.prompt.slice(0, 60)}"`);
      await this.sleep(1500);
      return { kind: "image", buffer: this.mockImageBuffer(), mimeType: "image/png", revisedPrompt: `[MOCK] ${input.prompt}` };
    }

    if (!input.model) throw new Error("图片模型未配置，请在账号设置中配置图片模型。");

    const base = this.apiBase(input.apiUrl);
    const references = this.mergeUrls(input.referenceImageUrls, input.referenceImageUrl);
    const aspectRatio = this.imageAspect(input.size);

    const body: JsonRecord = {
      model: input.model,
      prompt: input.prompt,
      n: 1,
      ...(aspectRatio ? { size: aspectRatio } : {}),
      ...(references.length > 0 ? { image_urls: references } : {}),
    };

    const submit = await this.postJson(`${base}/images/generations`, body, input.apiKey);
    const taskId = this.extractTaskId(submit);
    console.log(`[apimart] image task submitted: ${taskId}`);

    const result = await this.pollTask(base, taskId, input.apiKey, "image");
    const url = this.pickImageUrl(result);
    if (!url) {
      throw new Error(`APIMart 图片任务完成但缺少结果地址: ${JSON.stringify(result).slice(0, 500)}`);
    }

    const downloaded = await this.downloadByUrl(url);
    return {
      kind: "image",
      buffer: downloaded.buffer,
      mimeType: this.normalizeImageMime(downloaded.mimeType, input.outputFormat),
    };
  }

  // APIMart 暂无多模态提示词增强接口，保持接口一致：直接返回原始 prompt
  async enhancePrompt(input: EnhancePromptInput): Promise<string> {
    return input.originalPrompt;
  }

  // ── 视频：仅提交，返回 task_id（轮询交给 worker）────────────────────────
  async createVideoFromImage(input: CreateVideoInput): Promise<VideoOperation> {
    if (this.env.geminiMock) {
      console.log(`[MOCK][apimart] createVideoFromImage: prompt="${input.prompt.slice(0, 60)}"`);
      await this.sleep(1500);
      return { name: `mock-apimart-${Date.now()}`, done: false };
    }

    if (!input.model) throw new Error("视频模型未配置，请在账号设置中配置视频模型。");

    const base = this.apiBase(input.apiUrl);
    const references = this.mergeUrls(input.imageUrls, input.imageUrl);
    const aspectRatio = input.aspectRatio || (input.size === "720x1280" ? "9:16" : "16:9");
    const duration = this.normalizeDuration(input.seconds);
    const resolution = this.normalizeResolution(input.resolution);

    const body: JsonRecord = {
      model: input.model,
      prompt: input.prompt,
      aspect_ratio: aspectRatio,
      ...(resolution ? { resolution } : {}),
      ...(duration !== undefined ? { duration } : {}),
      // generation_type 交给 apib.ai 按图片数量自动判定（2→frame、3→reference）；单图不强制，
      // 强制 frame 会因"双帧插值需首尾两帧"而被拒
      ...(references.length > 0 ? { image_urls: references } : {}),
    };

    console.log(`[apimart] video create body: ${JSON.stringify(body)}`);
    const submit = await this.postJson(`${base}/videos/generations`, body, input.apiKey);
    const taskId = this.extractTaskId(submit);
    console.log(`[apimart] video task submitted: ${taskId}`);
    return { name: taskId, done: false };
  }

  /** 单次查询任务状态，归一化为带 status 字段的对象，供 worker 的 pollVideoCompletion 判定 */
  async getVideo(operationName: string, apiKey: string, apiUrl?: string) {
    if (this.env.geminiMock) {
      await this.sleep(800);
      return { status: "completed", result: { videos: [`mock://video/${operationName}`] }, raw: {} };
    }

    const base = this.apiBase(apiUrl);
    const data = await this.getJson(`${base}/tasks/${encodeURIComponent(operationName)}?language=zh`, apiKey);
    const d = (data?.data ?? data) as any;
    let status = String(d?.status ?? "").toLowerCase();
    // cancelled 归一化为 failed，避免 worker 轮询死循环（worker 自身的取消由 DB 状态驱动）
    if (status === "cancelled") status = "failed";
    return {
      status,
      result: d?.result,
      error: d?.error ?? d?.message,
      progress: d?.progress,
      raw: d,
    };
  }

  // APIMart 取消端点未在文档中明确，保持与 GeminiService 一致的静默策略
  async cancelVideo(operationName: string, _apiKey: string, _apiUrl?: string): Promise<void> {
    console.warn(`[apimart] cancelVideo: no explicit cancel endpoint, skip task ${operationName}`);
  }

  async downloadVideo(data: any, _apiKey: string, _apiUrl?: string): Promise<Buffer> {
    if (this.env.geminiMock) {
      await this.sleep(500);
      return this.mockVideoBuffer();
    }

    const url = this.pickVideoUrl(data?.result ?? data);
    if (!url) {
      throw new Error(`APIMart 视频结果缺少下载地址: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const downloaded = await this.downloadByUrl(url, 120_000);
    return downloaded.buffer;
  }

  // ── 内部：轮询任务直至完成/失败/超时（用于图片）─────────────────────────
  private async pollTask(base: string, taskId: string, apiKey: string, kind: "image" | "video") {
    const start = Date.now();
    for (;;) {
      const data = await this.getJson(`${base}/tasks/${encodeURIComponent(taskId)}?language=zh`, apiKey);
      const d = (data?.data ?? data) as any;
      const status = String(d?.status ?? "").toLowerCase();

      if (status === "completed") {
        return (d?.result ?? {}) as any;
      }
      if (["failed", "error", "cancelled"].includes(status)) {
        throw new Error(`APIMart ${kind} 任务${status}: ${JSON.stringify(d).slice(0, 500)}`);
      }
      if (Date.now() - start > ApimartService.IMAGE_POLL_TIMEOUT_MS) {
        throw new Error(`APIMart ${kind} 任务轮询超时 (${taskId})`);
      }
      await this.sleep(ApimartService.IMAGE_POLL_INTERVAL_MS);
    }
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
      throw new Error(`APIMart ${action} 非 JSON 响应 (${response.status}): ${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      throw new Error(`APIMart ${action} 失败 (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
    }
    // 业务层 code 非 200 也视为失败
    if (data && typeof data === "object" && "code" in data && data.code && data.code !== 200) {
      throw new Error(`APIMart ${action} 业务错误 (code=${data.code}): ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  private async downloadByUrl(url: string, timeoutMs = 60_000): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      const response = await fetch(url, {
        method: "GET",
        dispatcher: this.dispatcherFor(url),
        signal: AbortSignal.timeout(timeoutMs),
      } as any);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`APIMart 下载失败 (${response.status}): ${text.slice(0, 300)}`);
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
    const data = submit?.data;
    const entry = Array.isArray(data) ? data[0] : data;
    const id = entry?.task_id ?? entry?.id ?? submit?.task_id ?? submit?.id;
    if (!id) {
      throw new Error(`APIMart 提交未返回 task_id: ${JSON.stringify(submit).slice(0, 500)}`);
    }
    return String(id);
  }

  private pickImageUrl(result: any): string | undefined {
    const images = result?.images;
    if (Array.isArray(images) && images.length > 0) {
      const first = images[0];
      if (typeof first === "string") return first;
      if (first?.url) return Array.isArray(first.url) ? first.url[0] : first.url;
    }
    if (typeof result?.url === "string") return result.url;
    return undefined;
  }

  private pickVideoUrl(result: any): string | undefined {
    const videos = result?.videos;
    if (Array.isArray(videos) && videos.length > 0) {
      const first = videos[0];
      if (typeof first === "string") return first;
      if (first?.url) return Array.isArray(first.url) ? first.url[0] : first.url;
    }
    if (typeof result?.video_url === "string") return result.video_url;
    if (typeof result?.url === "string") return result.url;
    return undefined;
  }

  private imageAspect(size?: string): string | undefined {
    if (size === "1024x1024") return "1:1";
    if (size === "1024x1536") return "3:4";
    if (size === "1536x1024") return "4:3";
    if (size === "1024x1792") return "9:16";
    return undefined;
  }

  private normalizeDuration(seconds?: number): number | undefined {
    if (seconds === undefined || seconds === null) return undefined;
    return Math.min(Math.max(Math.round(seconds), 1), 15);
  }

  // seedance 2.0 仅接受 480p/720p/1080p（4k 暂不开放）；非法值返回 undefined，由 apib.ai 用默认 720p
  private normalizeResolution(resolution?: string): string | undefined {
    if (!resolution) return undefined;
    const value = resolution.trim().toLowerCase();
    return ["480p", "720p", "1080p"].includes(value) ? value : undefined;
  }

  private normalizeImageMime(
    downloaded: string,
    outputFormat: "png" | "jpeg" | "webp",
  ): "image/png" | "image/jpeg" | "image/webp" {
    if (downloaded === "image/jpeg" || downloaded === "image/jpg") return "image/jpeg";
    if (downloaded === "image/webp") return "image/webp";
    if (downloaded === "image/png") return "image/png";
    // 回退到请求时声明的输出格式
    if (outputFormat === "jpeg") return "image/jpeg";
    if (outputFormat === "webp") return "image/webp";
    return "image/png";
  }

  private normalizeMimeType(value: string): string {
    return value.split(";")[0].trim().toLowerCase();
  }

  private mergeUrls(list?: string[], single?: string): string[] {
    return Array.from(
      new Set([...(list ?? []), ...(single ? [single] : [])].filter(Boolean)),
    );
  }

  // ── base 解析：保证以 /v1 结尾 ─────────────────────────────────────────
  private apiBase(apiUrl?: string): string {
    const raw = apiUrl ?? this.env.geminiBaseUrl;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`APIMart apiUrl 非法: ${raw}`);
    }
    let path = u.pathname.replace(/\/+$/, "");
    const idx = path.indexOf("/v1");
    path = idx >= 0 ? path.slice(0, idx + 3) : "/v1";
    return `${u.protocol}//${u.host}${path}`;
  }

  // ── 代理调度（与 GeminiService 一致：内网直连，外网走代理）─────────────
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
      return new Error(`APIMart ${action} failed: ${String(error)}`);
    }
    const causeMessage =
      typeof error.cause === "object" && error.cause && "message" in error.cause
        ? String((error.cause as { message?: unknown }).message)
        : "";
    const proxyHint = this.env.proxyUrl
      ? `proxy=${this.env.proxyUrl}`
      : "no proxy configured; set HTTPS_PROXY in .env if apib.ai requires a proxy on this network";
    return new Error(
      `APIMart ${action} failed: ${error.message}${causeMessage ? ` | cause=${causeMessage}` : ""} | ${proxyHint}`,
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mockImageBuffer(): Buffer {
    const GRAY_1X1_PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return Buffer.from(GRAY_1X1_PNG, "base64");
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
