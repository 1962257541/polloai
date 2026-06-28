import { Injectable } from "@nestjs/common";
import { File } from "node:buffer";
import { Agent, Dispatcher, fetch, FormData, ProxyAgent } from "undici";
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

@Injectable()
export class QichenService implements GenerationProvider {
  private readonly remoteDispatcher?: Dispatcher;
  private readonly directDispatcher = new Agent();

  constructor(private readonly env: EnvService) {
    if (env.proxyUrl) {
      this.remoteDispatcher = new ProxyAgent(env.proxyUrl);
      console.log("Qichen requests will use proxy: " + env.proxyUrl);
    }
  }

  async generateImage(input: GenerateImageInput): Promise<ImageGenerationResult> {
    if (this.env.geminiMock) {
      console.log('[MOCK][qichen] generateImage: prompt="' + input.prompt.slice(0, 60) + '"');
      await this.sleep(1500);
      return { kind: "image", buffer: this.mockImageBuffer(), mimeType: "image/png", revisedPrompt: "[MOCK] " + input.prompt };
    }
    if (!input.model) throw new Error("图片模型未配置，请在账号设置中配置图片模型。");

    const base = this.apiBase(input.apiUrl);
    const references = this.mergeUrls(input.referenceImageUrls, input.referenceImageUrl);
    const result = references.length > 0
      ? await this.submitImageEdit(base, input, references)
      : await this.postJson(base + "/images/generations", {
          model: input.model,
          prompt: input.prompt,
          size: this.normalizeImageSize(input.size),
          quality: input.quality || "medium",
          n: 1,
        }, input.apiKey);

    const url = this.pickImageUrl(result);
    if (url) {
      const downloaded = await this.downloadByUrl(url, undefined, 120_000);
      return {
        kind: "image",
        buffer: downloaded.buffer,
        mimeType: this.normalizeImageMime(downloaded.mimeType, input.outputFormat),
        revisedPrompt: this.pickRevisedPrompt(result),
      };
    }

    const base64 = this.pickImageBase64(result);
    if (base64) {
      return {
        kind: "image",
        buffer: Buffer.from(base64, "base64"),
        mimeType: this.normalizeImageMime("", input.outputFormat),
        revisedPrompt: this.pickRevisedPrompt(result),
      };
    }
    throw new Error("七辰图片任务完成但缺少结果地址: " + JSON.stringify(result).slice(0, 500));
  }

  async enhancePrompt(input: EnhancePromptInput): Promise<string> {
    return input.originalPrompt;
  }

  async createVideoFromImage(input: CreateVideoInput): Promise<VideoOperation> {
    if (this.env.geminiMock) {
      console.log('[MOCK][qichen] createVideoFromImage: prompt="' + input.prompt.slice(0, 60) + '"');
      await this.sleep(1500);
      return { name: "mock-qichen-" + Date.now(), done: false };
    }
    if (!input.model) throw new Error("视频模型未配置，请在账号设置中配置视频模型。");

    const base = this.apiBase(input.apiUrl);
    const references = this.mergeUrls(input.imageUrls, input.imageUrl);
    const aspectRatio = input.aspectRatio || (input.size === "720x1280" ? "9:16" : "16:9");
    const duration = this.normalizeVideoDuration(input.model, input.seconds);
    const body: JsonRecord = {
      model: input.model,
      prompt: input.prompt,
      duration,
      aspect_ratio: aspectRatio,
      ...(references.length > 0 ? { images: references, Ingredients_images: references } : {}),
    };

    console.log("[qichen] video create body: " + JSON.stringify(body));
    const submit = await this.postJson(base + "/videos", body, input.apiKey);
    const taskId = this.extractTaskId(submit);
    console.log("[qichen] video task submitted: " + taskId);
    return { name: taskId, done: false };
  }

  async getVideo(operationName: string, apiKey: string, apiUrl?: string) {
    if (this.env.geminiMock) {
      await this.sleep(800);
      return { status: "completed", id: operationName, url: "mock://video/" + operationName, raw: {} };
    }
    const base = this.apiBase(apiUrl);
    const d = await this.getJson(base + "/videos/" + encodeURIComponent(operationName), apiKey);
    let status = String(d?.status ?? d?.state ?? d?.task_status ?? "").toLowerCase();
    if (["processing", "pending", "queued", "in_progress", "running"].includes(status)) status = "running";
    if (["completed", "succeeded", "success"].includes(status)) status = "completed";
    if (["failed", "error", "cancelled", "canceled"].includes(status)) status = "failed";
    return {
      status,
      id: d?.id ?? operationName,
      url: d?.url,
      video_url: d?.video_url,
      metadata: d?.metadata,
      error: d?.error ?? d?.message,
      progress: d?.progress,
      raw: d,
    };
  }

  async cancelVideo(operationName: string, _apiKey: string, _apiUrl?: string): Promise<void> {
    console.warn("[qichen] cancelVideo: no explicit cancel endpoint, skip task " + operationName);
  }

  async downloadVideo(data: any, apiKey: string, apiUrl?: string): Promise<Buffer> {
    if (this.env.geminiMock) {
      await this.sleep(500);
      return this.mockVideoBuffer();
    }
    const url = this.pickVideoUrl(data);
    if (!url) {
      const id = data?.id ?? data?.raw?.id;
      if (!id) throw new Error("七辰视频结果缺少下载地址: " + JSON.stringify(data).slice(0, 500));
      const base = this.apiBase(apiUrl);
      return (await this.downloadByUrl(base + "/videos/" + encodeURIComponent(id) + "/content", undefined, this.env.videoDownloadTimeoutMs)).buffer;
    }
    try {
      return (await this.downloadByUrl(url, undefined, this.env.videoDownloadTimeoutMs)).buffer;
    } catch (error) {
      const statusText = error instanceof Error ? error.message : String(error);
      if (!/(401|403|unauthorized|forbidden)/i.test(statusText)) throw error;
      return (await this.downloadByUrl(url, apiKey, this.env.videoDownloadTimeoutMs)).buffer;
    }
  }

  private async submitImageEdit(base: string, input: GenerateImageInput, references: string[]) {
    const form = new FormData();
    form.append("model", input.model);
    form.append("prompt", input.prompt);
    form.append("size", this.normalizeImageSize(input.size));
    form.append("quality", input.quality || "medium");
    for (const [index, url] of references.entries()) {
      const downloaded = await this.downloadByUrl(url, undefined, 120_000);
      const extension = this.extensionFromMime(downloaded.mimeType);
      const file = new File([downloaded.buffer], "reference-" + (index + 1) + "." + extension, { type: downloaded.mimeType || "image/png" });
      form.append("image[]", file);
    }
    return this.postForm(base + "/images/edits", form, input.apiKey);
  }

  private async postJson(url: string, body: JsonRecord, apiKey: string) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body),
        dispatcher: this.dispatcherFor(url),
      });
      return await this.parseJson(response, "POST " + url);
    } catch (error) {
      throw this.wrapFetchError(error, "POST " + url);
    }
  }

  private async postForm(url: string, form: FormData, apiKey: string) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey },
        body: form,
        dispatcher: this.dispatcherFor(url),
      });
      return await this.parseJson(response, "POST " + url);
    } catch (error) {
      throw this.wrapFetchError(error, "POST " + url);
    }
  }

  private async getJson(url: string, apiKey: string) {
    try {
      const response = await fetch(url, { method: "GET", headers: { Authorization: "Bearer " + apiKey }, dispatcher: this.dispatcherFor(url) });
      return await this.parseJson(response, "GET " + url);
    } catch (error) {
      throw this.wrapFetchError(error, "GET " + url);
    }
  }

  private async parseJson(response: Awaited<ReturnType<typeof fetch>>, action: string) {
    const text = await response.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("七辰 " + action + " 非 JSON 响应 (" + response.status + "): " + text.slice(0, 500));
    }
    if (!response.ok) throw new Error("七辰 " + action + " 失败 (" + response.status + "): " + JSON.stringify(data).slice(0, 500));
    if (data?.error) throw new Error("七辰 " + action + " 业务错误: " + JSON.stringify(data.error).slice(0, 500));
    return data;
  }

  private async downloadByUrl(url: string, apiKey?: string, timeoutMs = 60_000): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: apiKey ? { Authorization: "Bearer " + apiKey } : undefined,
        dispatcher: this.dispatcherFor(url),
        signal: AbortSignal.timeout(timeoutMs),
      } as any);
      if (!response.ok) {
        const text = await response.text();
        throw new Error("七辰下载失败 (" + response.status + "): " + text.slice(0, 300));
      }
      return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: this.normalizeMimeType(response.headers.get("content-type") || "") };
    } catch (error) {
      throw this.wrapFetchError(error, "GET " + url);
    }
  }

  private extractTaskId(submit: any): string {
    const id = submit?.id ?? submit?.task_id ?? submit?.data?.id ?? submit?.data?.task_id;
    if (!id) throw new Error("七辰提交未返回任务 id: " + JSON.stringify(submit).slice(0, 500));
    return String(id);
  }

  private pickImageUrl(payload: any): string | undefined {
    const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
    const candidates = [data?.url, data?.image_url, payload?.url, payload?.image_url, payload?.output_url, payload?.result?.url];
    return candidates.find((value) => typeof value === "string" && value);
  }

  private pickImageBase64(payload: any): string | undefined {
    const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
    const candidates = [data?.b64_json, data?.base64, payload?.b64_json, payload?.base64];
    return candidates.find((value) => typeof value === "string" && value);
  }

  private pickRevisedPrompt(payload: any): string | undefined {
    const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
    const value = data?.revised_prompt ?? data?.revisedPrompt ?? payload?.revised_prompt;
    return typeof value === "string" ? value : undefined;
  }

  private pickVideoUrl(data: any): string | undefined {
    const raw = data?.raw ?? data;
    const resultUrls = raw?.metadata?.result_urls ?? data?.metadata?.result_urls;
    const candidates = [
      data?.url,
      data?.video_url,
      data?.metadata?.url,
      data?.metadata?.video_url,
      Array.isArray(data?.metadata?.result_urls) ? data.metadata.result_urls[0] : undefined,
      raw?.url,
      raw?.video_url,
      raw?.metadata?.url,
      raw?.metadata?.video_url,
      Array.isArray(resultUrls) ? resultUrls[0] : undefined,
    ];
    return candidates.find((value) => typeof value === "string" && value);
  }

  private normalizeImageSize(size?: string): string {
    if (size === "1024x1792") return "1152x2048";
    if (size === "1536x1024") return "2048x1152";
    if (size === "1024x1536") return "1365x2048";
    if (size === "1024x1024") return "2048x2048";
    return size || "1152x2048";
  }

  private normalizeVideoDuration(model: string, seconds?: number): number {
    const value = Math.max(1, Math.min(15, Math.round(seconds ?? 15)));
    return model.trim().toLowerCase() === "sd2" ? 15 : value;
  }

  private normalizeImageMime(downloaded: string, outputFormat: "png" | "jpeg" | "webp"): "image/png" | "image/jpeg" | "image/webp" {
    if (downloaded === "image/jpeg" || downloaded === "image/jpg") return "image/jpeg";
    if (downloaded === "image/webp") return "image/webp";
    if (downloaded === "image/png") return "image/png";
    if (outputFormat === "jpeg") return "image/jpeg";
    if (outputFormat === "webp") return "image/webp";
    return "image/png";
  }

  private normalizeMimeType(value: string): string {
    return value.split(";")[0].trim().toLowerCase();
  }

  private extensionFromMime(mimeType: string): string {
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("png")) return "png";
    return "png";
  }

  private mergeUrls(list?: string[], single?: string): string[] {
    return Array.from(new Set([...(list ?? []), ...(single ? [single] : [])].filter(Boolean)));
  }

  private apiBase(apiUrl?: string): string {
    const raw = apiUrl ?? this.env.geminiBaseUrl;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("七辰 apiUrl 非法: " + raw);
    }
    let path = u.pathname.replace(/\/+$/, "");
    const idx = path.indexOf("/v1");
    path = idx >= 0 ? path.slice(0, idx + 3) : "/v1";
    return u.protocol + "//" + u.host + path;
  }

  private dispatcherFor(url: string) {
    if (!this.remoteDispatcher) return undefined;
    return this.isLocalOrPrivateUrl(url) ? this.directDispatcher : this.remoteDispatcher;
  }

  private isLocalOrPrivateUrl(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".local")) return true;
      return /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
    } catch {
      return false;
    }
  }

  private wrapFetchError(error: unknown, action: string): Error {
    if (!(error instanceof Error)) return new Error("七辰 " + action + " failed: " + String(error));
    const causeMessage =
      typeof error.cause === "object" && error.cause && "message" in error.cause
        ? String((error.cause as { message?: unknown }).message)
        : "";
    const proxyHint = this.env.proxyUrl
      ? "proxy=" + this.env.proxyUrl
      : "no proxy configured; set HTTPS_PROXY in .env if api.qichen001.asia requires a proxy on this network";
    return new Error("七辰 " + action + " failed: " + error.message + (causeMessage ? " | cause=" + causeMessage : "") + " | " + proxyHint);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mockImageBuffer(): Buffer {
    const gray = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return Buffer.from(gray, "base64");
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
