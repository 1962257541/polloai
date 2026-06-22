/**
 * 生成供应商抽象接口（策略模式 / DIP）。
 *
 * GeminiService（yunwu 同步图片 + create/query 视频）与
 * ApimartService（apib.ai 异步任务制 /v1/tasks 轮询）均实现此接口，
 * worker 按账号的 apiProvider 选择具体实现，彼此可替换（LSP）。
 */

export type InlineImagePart = {
  mimeType?: string;
  data?: string;
};

export type ImageGenerationResult =
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

export interface GenerateImageInput {
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
}

export interface EnhancePromptInput {
  originalPrompt: string;
  referenceImageUrls: string[];
  apiKey: string;
  apiUrl?: string;
}

export interface CreateVideoInput {
  model: string;
  prompt: string;
  imageUrl?: string;
  imageUrls?: string[];
  aspectRatio?: string;
  size?: string;
  seconds?: number;
  apiKey: string;
  apiUrl?: string;
}

/** 视频提交返回：name 即后续轮询用的 providerJobId（任务号） */
export interface VideoOperation {
  name: string;
  done?: boolean;
}

/**
 * 视频轮询返回需归一化为带 `status` 字段的对象，供 worker 统一判定：
 * - status === "completed" 表示成功
 * - status ∈ {failed,error,...} 表示失败
 * downloadVideo 接收同一对象，从中解析最终视频直链。
 */
export interface GenerationProvider {
  generateImage(input: GenerateImageInput): Promise<ImageGenerationResult>;
  enhancePrompt(input: EnhancePromptInput): Promise<string>;
  createVideoFromImage(input: CreateVideoInput): Promise<VideoOperation>;
  getVideo(operationName: string, apiKey: string, apiUrl?: string): Promise<any>;
  cancelVideo(operationName: string, apiKey: string, apiUrl?: string): Promise<void>;
  downloadVideo(data: any, apiKey: string, apiUrl?: string): Promise<Buffer>;
}
