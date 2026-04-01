import { z } from "zod";

export const generationTypeValues = ["text_to_image", "image_to_video"] as const;
export type GenerationType = (typeof generationTypeValues)[number];

export const taskStatusValues = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof taskStatusValues)[number];

export const providerValues = ["gemini"] as const;
export type Provider = (typeof providerValues)[number];

export const aspectRatioValues = ["1:1", "16:9", "9:16"] as const;
export type AspectRatio = (typeof aspectRatioValues)[number];

export const imageQualityValues = ["low", "medium", "high", "auto"] as const;
export type ImageQuality = (typeof imageQualityValues)[number];

export const videoQualityValues = ["standard", "high"] as const;
export type VideoQuality = (typeof videoQualityValues)[number];

export const imageApiTypeValues = ["openai-images", "gemini-native"] as const;
export type ImageApiType = (typeof imageApiTypeValues)[number];

export const textToImageSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  negativePrompt: z.string().trim().max(1000).optional(),
  model: z.string().trim().optional(),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024", "1024x1792"]).default("1024x1024"),
  quality: z.enum(imageQualityValues).default("auto"),
  background: z.enum(["transparent", "opaque", "auto"]).default("auto"),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  imageApiType: z.enum(imageApiTypeValues).default("gemini-native"),
  referenceImageUrl: z.string().url().optional(),
  referenceImageUrls: z.array(z.string().url()).optional(),
});

export const imageToVideoSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  negativePrompt: z.string().trim().max(1000).optional(),
  model: z.string().trim().optional(),
  imageUrl: z.string().url().optional(),
  aspectRatio: z.enum(aspectRatioValues).default("16:9"),
  size: z.enum(["1280x720", "720x1280"]).default("1280x720"),
  durationSec: z.number().int().min(4).max(8).default(4),
  quality: z.enum(videoQualityValues).default("standard"),
});

export type TextToImageInput = z.infer<typeof textToImageSchema>;
export type ImageToVideoInput = z.infer<typeof imageToVideoSchema>;

export interface TextToImageParameters extends TextToImageInput {
  enhancedPrompt?: string;  // 增强后的 prompt
  responseText?: string;     // 模型返回的文本响应
}

export interface GenerationCreatedResponse {
  taskId: string;
  status: TaskStatus;
}

export interface GenerationEvent {
  taskId: string;
  userId: string;
  status: TaskStatus;
  type: GenerationType;
  errorMessage?: string;
  assetUrl?: string;
  responseText?: string;
}

export type UserRole = "admin" | "salesperson";

export interface SalespersonInfo {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  hasApiKey: boolean;
  hasApiUrl: boolean;
  apiUrl?: string | null;
  imageModel?: string | null;
  imageModels?: string[];
  videoModel?: string | null;
  videoModels?: string[];
}

export interface CreateSalespersonDto {
  email: string;
  name?: string;
  password: string;
}
