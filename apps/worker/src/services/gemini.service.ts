import { Injectable } from "@nestjs/common";
import { Agent, Dispatcher, fetch, ProxyAgent } from "undici";
import { EnvService } from "./env.service";

type JsonRecord = Record<string, unknown>;

type InlineImagePart = {
  mimeType?: string;
  data?: string;
};

type ImageGenerationResult =
  | {
      kind: "image";
      buffer: Buffer;
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      revisedPrompt?: string;
    }
  | {
      kind: "text";
      responseText: string;
    };

@Injectable()
export class GeminiService {
  private readonly remoteDispatcher?: Dispatcher;
  private readonly directDispatcher = new Agent();

  constructor(private readonly env: EnvService) {
    if (env.proxyUrl) {
      this.remoteDispatcher = new ProxyAgent(env.proxyUrl);
      console.log(`Gemini requests will use proxy: ${env.proxyUrl}`);
    }
  }

  async generateImage(input: {
    model: string;
    prompt: string;
    size: string;
    quality: string;
    background: string;
    outputFormat: "png" | "jpeg" | "webp";
    apiKey: string;
    apiUrl?: string;
    imageApiType?: string;
    referenceImageUrl?: string;
    referenceImageUrls?: string[];
  }): Promise<ImageGenerationResult> {
    if (this.env.geminiMock) {
      console.log(`[MOCK] generateImage: prompt="${input.prompt.slice(0, 60)}" size=${input.size}`);
      await this.mockDelay(1500);
      return {
        kind: "image",
        buffer: this.mockImageBuffer(input.prompt, input.size),
        mimeType: "image/png" as const,
        revisedPrompt: `[MOCK] ${input.prompt}`,
      };
    }

    const model = input.model;
    if (!model) throw new Error("图片模型未配置，请在账号设置中配置图片模型。");

    // 合并所有参考图 URL（兼容单图旧字段 + 新多图字段）
    const allReferenceUrls = [
      ...(input.referenceImageUrls ?? []),
      ...(input.referenceImageUrl && !input.referenceImageUrls?.includes(input.referenceImageUrl)
        ? [input.referenceImageUrl]
        : []),
    ].filter(Boolean);

    if (input.imageApiType === "gemini-native") {
      return this.generateImageNative(
        model,
        input.prompt,
        input.size,
        input.outputFormat,
        input.apiKey,
        input.apiUrl,
        allReferenceUrls,
      );
    }

    if (allReferenceUrls.length > 0) {
      throw new Error("Reference images are currently only supported in Gemini mode");
    }

    // openai-images（默认）
    const body = await this.requestOpenAIImages(
      {
        model,
        prompt: input.prompt,
        size: input.size as any,
        n: 1,
        response_format: "b64_json",
      },
      input.apiKey,
      input.apiUrl,
    );

    const b64 = body?.data?.[0]?.b64_json as string | undefined;
    if (!b64) {
      throw new Error(`Image response missing b64_json: ${JSON.stringify(body).slice(0, 500)}`);
    }

    const mimeType =
      input.outputFormat === "jpeg"
        ? "image/jpeg"
        : input.outputFormat === "webp"
          ? "image/webp"
          : "image/png";

    return {
      kind: "image",
      buffer: Buffer.from(b64, "base64"),
      mimeType,
      revisedPrompt: body?.data?.[0]?.revised_prompt as string | undefined,
    };
  }

  private async generateImageNative(
    model: string,
    prompt: string,
    size: string,
    outputFormat: "png" | "jpeg" | "webp",
    apiKey: string,
    apiUrl?: string,
    referenceImageUrls: string[] = [],
  ): Promise<ImageGenerationResult> {
    const requestParts: JsonRecord[] = [];

    for (const url of referenceImageUrls) {
      console.log(`[generateImage] Loading reference image: ${url}`);
      const referenceImage = await this.loadImage(url);
      if (!referenceImage.mimeType.startsWith("image/")) {
        throw new Error(`Reference image URL did not return an image (got ${referenceImage.mimeType}): ${url}`);
      }
      console.log(`[generateImage] Loaded reference image: ${referenceImage.mimeType} ${referenceImage.buffer.byteLength} bytes`);
      requestParts.push({
        inlineData: {
          mimeType: referenceImage.mimeType,
          data: referenceImage.buffer.toString("base64"),
        },
      });
    }

    requestParts.push({
      text: prompt,
    });

    const aspectRatio = this.imageAspectRatioFromSize(size);
    const path = `/models/${encodeURIComponent(model)}:generateContent`;
    const body = await this.requestJson(
      path,
      {
        method: "POST",
        body: {
          contents: [{ parts: requestParts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            // 标准 Gemini 原生字段
            ...(aspectRatio ? { aspectRatio } : {}),
            // 中转站（new-api）使用 imageConfig.aspectRatio
            ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
          },
        },
      },
      apiKey,
      apiUrl,
    );

    // 从 parts 中找 inlineData
    const responseParts: Array<{ inlineData?: InlineImagePart; text?: string }> =
      body?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find((part) => part.inlineData?.mimeType?.startsWith("image/"));
    if (!imagePart) {
      const responseText = this.collectResponseText(responseParts);
      if (responseText) {
        return {
          kind: "text",
          responseText,
        };
      }
      throw new Error(`Gemini native response missing image part: ${JSON.stringify(body).slice(0, 500)}`);
    }

    const b64 = imagePart.inlineData?.data;
    if (!b64) {
      throw new Error(`Gemini native response missing image data: ${JSON.stringify(body).slice(0, 500)}`);
    }
    const buffer = Buffer.from(b64, "base64");
    const mimeType =
      outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";

    // 诊断：打印返回的图像信息，用于排查"绿色占位图"等代理返回异常数据的情况
    console.log(
      `[generateImageNative] model=${model} b64Len=${b64.length} bufferBytes=${buffer.byteLength} ` +
        `respMimeType=${imagePart.inlineData?.mimeType} outMimeType=${mimeType} ` +
        `b64Head=${b64.slice(0, 80)}`,
    );
    if (buffer.byteLength < 1024) {
      console.warn(
        `[generateImageNative] SUSPICIOUSLY SMALL IMAGE (${buffer.byteLength} bytes). ` +
          `Full response: ${JSON.stringify(body).slice(0, 1500)}`,
      );
    }

    return {
      kind: "image",
      buffer,
      mimeType,
      revisedPrompt: responseParts.find((part) => part.text)?.text,
    };
  }

  private collectResponseText(parts: Array<{ text?: string }>) {
    return parts
      .map((part) => part.text?.replace(/\s+/g, " ").trim())
      .filter((text): text is string => Boolean(text))
      .join(" ")
      .slice(0, 300);
  }

  async enhancePrompt(input: {
    originalPrompt: string;
    referenceImageUrls: string[];
    apiKey: string;
    apiUrl?: string;
  }): Promise<string> {
    const { originalPrompt, referenceImageUrls, apiKey, apiUrl } = input;

    // 限制最多5张参考图
    const urls = referenceImageUrls.slice(0, 5);
    if (urls.length === 0) {
      return originalPrompt;
    }

    console.log(`[enhancePrompt] Enhancing prompt with ${urls.length} reference images`);

    try {
      const requestParts: JsonRecord[] = [];

      // 加载所有参考图（复用现有 loadImage 方法）
      for (const url of urls) {
        const image = await this.loadImage(url);
        requestParts.push({
          inlineData: {
            mimeType: image.mimeType,
            data: image.buffer.toString("base64"),
          },
        });
      }

      // 构建增强请求
      const systemInstruction = this.buildEnhancementSystemPrompt();
      requestParts.push({
        text: originalPrompt || "请根据参考图生成详细的图像描述",
      });

      // 调用 Gemini 文本生成 API（复用现有 requestJson 方法）
      const path = `/models/gemini-2.0-flash-exp:generateContent`;
      const body = await this.requestJson(
        path,
        {
          method: "POST",
          body: {
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            contents: [{ parts: requestParts }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 1000,
            },
          },
        },
        apiKey,
        apiUrl,
      );

      // 提取增强后的 prompt（复用现有 collectResponseText 方法）
      const responseParts: Array<{ text?: string }> = body?.candidates?.[0]?.content?.parts ?? [];
      const enhancedPrompt = this.collectResponseText(responseParts);

      // 验证结果有效性
      if (!enhancedPrompt || enhancedPrompt.length < 10) {
        console.warn(`[enhancePrompt] Enhancement returned empty/short result, using original`);
        return originalPrompt;
      }

      console.log(`[enhancePrompt] Original: "${originalPrompt.slice(0, 60)}..."`);
      console.log(`[enhancePrompt] Enhanced: "${enhancedPrompt.slice(0, 60)}..."`);
      return enhancedPrompt;

    } catch (error) {
      console.error(`[enhancePrompt] Failed to enhance prompt:`, error);
      return originalPrompt; // 降级：返回原始 prompt
    }
  }

  private buildEnhancementSystemPrompt(): string {
    return `你是一个专业的视觉提示词增强专家。你的任务是分析参考图片，提取其"视觉DNA"（风格、配色、光影、构图、质感、氛围），并将其融入用户的原始描述中，生成一个增强后的图像生成提示词。

**核心原则：**
1. 不要描述参考图的具体内容（如"一张动画片截图"），而是提取其风格特征（如"水彩质感、柔和光影、自然色调"）
2. 保留用户原始描述的核心意图和主体内容
3. 将提取的视觉特征自然地融入描述中
4. 输出纯文本提示词，不包含任何解释、标题或元信息

**提取维度：**
- 艺术风格：写实/插画/3D渲染/水彩/油画/赛博朋克等
- 色彩方案：主色调、饱和度、对比度、色温
- 光影效果：自然光/戏剧性光影/柔和漫射/强烈对比
- 构图特点：对称/黄金分割/留白/景深
- 质感细节：细腻/粗糙/光滑/颗粒感
- 情绪氛围：温暖/冷峻/梦幻/紧张

**输出格式：**
直接输出增强后的提示词，不要包含"增强后的提示词："等前缀。

**示例：**
用户输入："一只猫坐在窗边"
参考图：吉卜力风格的场景
输出："一只猫坐在窗边，水彩画风格，柔和的自然光透过窗户洒落，温暖的色调，细腻的笔触，宁静祥和的氛围，景深效果突出主体"`;
  }

  async createVideoFromImage(input: {
    model: string;
    prompt: string;
    imageUrl?: string;
    imageUrls?: string[];
    aspectRatio?: string;
    size?: string;
    seconds?: number;
    apiKey: string;
    apiUrl?: string;
  }) {
    if (this.env.geminiMock) {
      console.log(`[MOCK] createVideoFromImage: prompt="${input.prompt.slice(0, 60)}"`);
      await this.mockDelay(2000);
      return { name: `mock-operations/${Date.now()}`, done: false } as { name: string; done?: boolean };
    }

    const videoModel = input.model;
    if (!videoModel) throw new Error("视频模型未配置，请在账号设置中配置视频模型。");

    const aspectRatio = input.aspectRatio || this.videoAspectRatioFromSize(input.size);

    // 合并多张参考图（imageUrls 优先，向后兼容单张 imageUrl），去重
    const sourceUrls = Array.from(
      new Set([...(input.imageUrls ?? []), ...(input.imageUrl ? [input.imageUrl] : [])].filter(Boolean)),
    );
    if (sourceUrls.length === 0) throw new Error("图生视频缺少参考图。");

    console.log(`[createVideoFromImage] reference images count=${sourceUrls.length}`);

    // 逐张确保为 imageproxy 直链（非直链则上传），保持顺序
    const proxyUrls: string[] = [];
    for (const src of sourceUrls) {
      console.log(`[createVideoFromImage] Original imageUrl: ${src}, isImageProxyUrl=${this.isImageProxyUrl(src)}`);
      const proxied = this.isImageProxyUrl(src)
        ? src
        : await this.withRetry(
            () => this.uploadImageToImageProxy(src, input.apiKey),
            3,
            1000,
            "uploadImageToImageProxy",
          );
      proxyUrls.push(proxied);
    }

    console.log(`[createVideoFromImage] Final imageUrls for API: ${JSON.stringify(proxyUrls)}`);

    const base = new URL(input.apiUrl ?? this.env.geminiBaseUrl);
    const url = `${base.protocol}//${base.host}/v1/video/create`;
    const durationSeconds = input.seconds ? this.normalizeVideoDuration(input.seconds, videoModel) : undefined;
    const reqBody = this.buildVideoCreateBody({
      model: videoModel,
      prompt: input.prompt,
      aspectRatio,
      imageUrls: proxyUrls,
      durationSeconds,
    });

    // 诊断日志：记录完整请求体
    console.log(
      `[createVideoFromImage] requested seconds=${input.seconds}, normalized=${durationSeconds}`,
    );
    console.log(`[createVideoFromImage] Request body: ${JSON.stringify(reqBody)}`);

    let result = await this.postVideoCreate(url, input.apiKey, reqBody);
    if (!result.ok && this.isOmniFlashVideoModel(videoModel) && this.isVideoImageFieldValidationError(result.data)) {
      const fallbackBody = this.buildOmniFlashPromptOnlyVideoCreateBody({
        model: videoModel,
        prompt: input.prompt,
        aspectRatio,
        imageUrls: proxyUrls,
        durationSeconds,
      });
      console.warn(
        `[createVideoFromImage] Omni Flash rejected image URL fields, retrying with prompt-only references: ${JSON.stringify(result.data).slice(0, 500)}`,
      );
      console.log(`[createVideoFromImage] Fallback request body: ${JSON.stringify(fallbackBody)}`);
      result = await this.postVideoCreate(url, input.apiKey, fallbackBody);
    }

    if (!result.ok) {
      throw new Error(`Video create failed (${result.status}): ${JSON.stringify(result.data).slice(0, 500)}`);
    }
    if (!result.data?.id) {
      throw new Error(`Video create response missing id: ${JSON.stringify(result.data).slice(0, 500)}`);
    }

    return { name: result.data.id as string, done: false };
  }

  async getVideo(operationName: string, apiKey: string, apiUrl?: string) {
    if (this.env.geminiMock) {
      console.log(`[MOCK] getVideo: ${operationName}`);
      await this.mockDelay(1000);
      return { id: operationName, status: "completed", video_url: `mock://video/${operationName}` };
    }

    const base = new URL(apiUrl ?? this.env.geminiBaseUrl);
    const url = `${base.protocol}//${base.host}/v1/video/query?id=${encodeURIComponent(operationName)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      dispatcher: this.dispatcherFor(url),
    });

    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      throw new Error(`Video query non-JSON response (${response.status}): ${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      throw new Error(`Video query failed (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  async cancelVideo(operationName: string, apiKey: string, apiUrl?: string) {
    // yunwu /v1/video 接口暂无取消端点，静默忽略
    console.warn(`cancelVideo: no cancel endpoint available for task ${operationName}`);
  }

  async downloadVideo(data: any, apiKey: string, apiUrl?: string): Promise<Buffer> {
    if (this.env.geminiMock) {
      console.log(`[MOCK] downloadVideo`);
      await this.mockDelay(500);
      return this.mockVideoBuffer();
    }

    const videoUrl: string | undefined = data?.video_url;
    if (!videoUrl) {
      throw new Error(`Video query response missing video_url: ${JSON.stringify(data).slice(0, 500)}`);
    }

    // video_url 是外部 CDN 直链，直接下载，不带 API Key，走代理（视频文件较大，给120秒超时）
    return this.downloadVideoByUrl(videoUrl);
  }

  private async uploadImageToImageProxy(imageUrl: string, apiKey: string) {
    console.log(`[uploadImageToImageProxy] Starting upload for: ${imageUrl}`);

    const referenceImage = await this.loadImage(imageUrl);
    console.log(`[uploadImageToImageProxy] Loaded image: ${referenceImage.mimeType}, ${referenceImage.buffer.byteLength} bytes`);

    const url = "https://imageproxy.zhongzhuan.chat/api/upload";
    const fileName = `reference.${this.extensionFromMimeType(referenceImage.mimeType)}`;
    const multipart = this.buildMultipartFileBody("file", fileName, referenceImage.mimeType, referenceImage.buffer);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": multipart.contentType,
          "Content-Length": String(multipart.body.byteLength),
        },
        body: multipart.body,
        dispatcher: this.dispatcherFor(url),
      });

      const text = await response.text();
      console.log(`[uploadImageToImageProxy] Response status: ${response.status}, body: ${text.slice(0, 500)}`);

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Image proxy upload non-JSON response (${response.status}): ${text.slice(0, 500)}`);
      }

      if (!response.ok) {
        throw new Error(`Image proxy upload failed (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
      }

      const publicUrl = data?.url as string | undefined;
      if (!publicUrl) {
        throw new Error(`Image proxy upload response missing url: ${JSON.stringify(data).slice(0, 500)}`);
      }

      console.log(`[uploadImageToImageProxy] Proxy URL returned: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      throw this.wrapFetchError(error, `POST ${url}`);
    }
  }

  private async downloadVideoByUrl(videoUrl: string) {
    try {
      const response = await fetch(videoUrl, {
        method: "GET",
        dispatcher: this.dispatcherFor(videoUrl),
        signal: AbortSignal.timeout(120_000),
      } as any);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Video download failed (${response.status}): ${text.slice(0, 500)}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw this.wrapFetchError(error, `GET ${videoUrl}`);
    }
  }

  private async loadImage(url: string) {
    try {
      const response = await fetch(url, {
        method: "GET",
        dispatcher: this.dispatcherFor(url),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Input image fetch failed (${response.status}): ${text.slice(0, 500)}`);
      }

      const headerMimeType = this.normalizeMimeType(response.headers.get("content-type") || "");
      const mimeType = headerMimeType.startsWith("image/")
        ? headerMimeType
        : this.mimeFromPath(url) || headerMimeType;

      if (!mimeType.startsWith("image/")) {
        throw new Error(
          `Input image URL did not return an image. URL must be a direct image link: ${url}`,
        );
      }

      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType,
      };
    } catch (error) {
      throw this.wrapFetchError(error, `GET ${url}`);
    }
  }

  private async requestOpenAIImages(body: JsonRecord, apiKey: string, apiUrl?: string) {
    const url = this.openAIUrl("/v1/images/generations", apiUrl);
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

      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response (${response.status}): ${text.slice(0, 500)}`);
      }

      if (!response.ok) {
        throw new Error(`Image API failed (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
      }

      return data;
    } catch (error) {
      throw this.wrapFetchError(error, `POST ${url}`);
    }
  }

  private async requestJson(
    pathOrUrl: string,
    input: { method: string; body?: JsonRecord },
    apiKey: string,
    apiUrl?: string,
  ) {
    const response = await this.request(pathOrUrl, { method: input.method, body: input.body, expectJson: true }, apiKey, apiUrl);
    return response as any;
  }

  private async requestBuffer(pathOrUrl: string, isAbsolute = false, apiKey: string, apiUrl?: string) {
    const url = isAbsolute ? pathOrUrl : this.absoluteUrl(pathOrUrl, apiUrl);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-goog-api-key": apiKey,
        },
        dispatcher: this.dispatcherFor(url),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini file download failed (${response.status}): ${text.slice(0, 500)}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw this.wrapFetchError(error, `GET ${url}`);
    }
  }

  private async request(
    pathOrUrl: string,
    input: {
      method: string;
      body?: JsonRecord;
      expectJson: boolean;
    },
    apiKey: string,
    apiUrl?: string,
  ) {
    const url = this.absoluteUrl(pathOrUrl, apiUrl);

    try {
      const response = await fetch(url, {
        method: input.method,
        headers: {
          // 同时发送两种鉴权头：原生 Gemini 用 x-goog-api-key，中转站用 Authorization Bearer
          "x-goog-api-key": apiKey,
          "Authorization": `Bearer ${apiKey}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
        dispatcher: this.dispatcherFor(url),
      });

      if (!input.expectJson) {
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Gemini request failed (${response.status}): ${text.slice(0, 500)}`);
        }
        return null;
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(`Gemini request failed (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
      }

      return data;
    } catch (error) {
      throw this.wrapFetchError(error, `${input.method} ${url}`);
    }
  }

  private absoluteUrl(pathOrUrl: string, baseUrl?: string) {
    if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
      return pathOrUrl;
    }
    let base = baseUrl ?? this.env.geminiBaseUrl;
    // 如果 base 只是 host（无路径或路径为 "/"），自动补 /v1beta
    try {
      const u = new URL(base);
      if (!u.pathname || u.pathname === "/") {
        base = `${u.protocol}//${u.host}/v1beta`;
      } else {
        base = base.replace(/\/$/, "");
      }
    } catch {
      base = base.replace(/\/$/, "");
    }
    return `${base}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
  }

  private openAIUrl(path: string, baseUrl?: string) {
    const base = new URL(baseUrl ?? this.env.geminiBaseUrl);
    return `${base.protocol}//${base.host}${path}`;
  }

  private dispatcherFor(url: string) {
    if (!this.remoteDispatcher) return undefined;
    return this.shouldBypassProxy(url) ? this.directDispatcher : this.remoteDispatcher;
  }

  private shouldBypassProxy(url: string) {
    return this.isLocalOrPrivateUrl(url);
  }

  private isLocalOrPrivateUrl(url: string) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".local")) {
        return true;
      }
      if (
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private isImageProxyUrl(url: string) {
    try {
      const parsed = new URL(url);
      // 只检查 hostname，不限制具体路径（上传返回的 URL 可能是 /api/files/xxx 等不同路径）
      return parsed.hostname === "imageproxy.zhongzhuan.chat";
    } catch {
      return false;
    }
  }

  private wrapFetchError(error: unknown, action: string) {
    if (!(error instanceof Error)) {
      return new Error(`Gemini ${action} failed: ${String(error)}`);
    }

    const causeMessage =
      typeof error.cause === "object" && error.cause && "message" in error.cause
        ? String((error.cause as { message?: unknown }).message)
        : "";

    const proxyHint = this.env.proxyUrl
      ? `proxy=${this.env.proxyUrl}`
      : "no proxy configured; set HTTPS_PROXY in .env if Gemini requires a proxy on this network";

    return new Error(
      `Gemini ${action} failed: ${error.message}${causeMessage ? ` | cause=${causeMessage}` : ""} | ${proxyHint}`,
    );
  }

  private extractVideoUrl(data: any): string | undefined {
    return (
      data?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
      data?.response?.generatedVideos?.[0]?.video?.uri ||
      data?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    );
  }

  private videoAspectRatioFromSize(size?: string) {
    if (size === "720x1280") return "9:16";
    return "16:9";
  }

  private imageAspectRatioFromSize(size?: string) {
    if (size === "1024x1024") return "1:1";
    if (size === "1024x1536") return "3:4";
    if (size === "1536x1024") return "4:3";
    if (size === "1024x1792") return "9:16";
    return undefined;
  }

  private videoResolutionFromSize(size?: string) {
    if (size === "1280x720" || size === "720x1280") return "720p";
    return this.env.geminiVideoResolution;
  }

  private buildVideoCreateBody(input: {
    model: string;
    prompt: string;
    aspectRatio: string;
    imageUrls: string[];
    durationSeconds?: number;
  }): JsonRecord {
    if (this.isOmniFlashVideoModel(input.model)) {
      const [imageUrl, ...extraImageUrls] = input.imageUrls;
      const prompt = extraImageUrls.length > 0
        ? `${input.prompt}\n\nAdditional reference image URLs:\n${extraImageUrls.join("\n")}`
        : input.prompt;

      return {
        model: input.model,
        prompt,
        aspectRatio: input.aspectRatio,
        imageUrl,
        ...(input.durationSeconds !== undefined ? { durationSec: input.durationSeconds } : {}),
      };
    }

    return {
      model: input.model,
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      images: input.imageUrls,
      ...(input.durationSeconds !== undefined ? { duration_seconds: input.durationSeconds } : {}),
    };
  }

  private buildOmniFlashPromptOnlyVideoCreateBody(input: {
    model: string;
    prompt: string;
    aspectRatio: string;
    imageUrls: string[];
    durationSeconds?: number;
  }): JsonRecord {
    const referenceText = input.imageUrls.length > 0
      ? `\n\nReference image URLs:\n${input.imageUrls.join("\n")}`
      : "";

    return {
      model: input.model,
      prompt: `${input.prompt}${referenceText}`,
      aspectRatio: input.aspectRatio,
      ...(input.durationSeconds !== undefined ? { durationSec: input.durationSeconds } : {}),
    };
  }

  private async postVideoCreate(url: string, apiKey: string, body: JsonRecord) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      dispatcher: this.dispatcherFor(url),
    });

    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      throw new Error(`Video create non-JSON response (${response.status}): ${text.slice(0, 500)}`);
    }

    return { ok: response.ok, status: response.status, data };
  }

  private isVideoImageFieldValidationError(data: unknown) {
    const text = JSON.stringify(data).toLowerCase();
    return /property\s+imageurls\s+should\s+not\s+exist|property\s+imageurl\s+should\s+not\s+exist|imageurls?\s+should\s+not\s+exist/.test(text);
  }

  private isOmniFlashVideoModel(model: string) {
    return /(^|[-_\/])omni[-_]?flash($|[-_\/])|gemini[-_]?omni[-_]?flash/i.test(model);
  }

  private normalizeVideoDuration(seconds: number, model?: string) {
    if (model && this.isOmniFlashVideoModel(model)) {
      const allowed = [6, 8];
      return allowed.reduce((best, cur) =>
        Math.abs(cur - seconds) < Math.abs(best - seconds) ? cur : best,
      );
    }

    // UI 仅提供 5/10/15 三档，吸附到最近的合法档位
    const allowed = [5, 10, 15];
    return allowed.reduce((best, cur) =>
      Math.abs(cur - seconds) < Math.abs(best - seconds) ? cur : best,
    );
  }

  private normalizeMimeType(value: string) {
    return value.split(";")[0].trim().toLowerCase();
  }

  private extensionFromMimeType(value: string) {
    if (value === "image/jpeg") return "jpg";
    if (value === "image/webp") return "webp";
    return "png";
  }

  private buildMultipartFileBody(fieldName: string, fileName: string, contentType: string, buffer: Buffer) {
    const boundary = `----CodexBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;

    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: Buffer.concat([Buffer.from(head, "utf8"), buffer, Buffer.from(tail, "utf8")]),
    };
  }

  private mimeFromPath(value: string) {
    const pathname = new URL(value).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "image/png";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
    return undefined;
  }

  // ── Mock helpers ──────────────────────────────────────────────────────────

  private mockDelay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mockImageBuffer(_prompt: string, _size: string): Buffer {
    const GRAY_1X1_PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return Buffer.from(GRAY_1X1_PNG, "base64");
  }

  private mockVideoBuffer(): Buffer {
    const ftyp = Buffer.from([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x02, 0x00,
      0x69, 0x73, 0x6f, 0x6d,
      0x69, 0x73, 0x6f, 0x32,
    ]);
    const mdat = Buffer.from([
      0x00, 0x00, 0x00, 0x08,
      0x6d, 0x64, 0x61, 0x74,
    ]);
    return Buffer.concat([ftyp, mdat]);
  }

  // ── Retry helper ───────────────────────────────────────────────────────────

  private async withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts: number,
    delayMs: number,
    label: string,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[${label}] Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
        }
      }
    }
    throw lastError;
  }
}
