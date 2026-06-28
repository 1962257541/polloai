import { Injectable } from "@nestjs/common";
import { config } from "dotenv";
import { z } from "zod";
import { RedisOptions } from "bullmq";
import { existsSync } from "fs";
import { resolve } from "path";

function loadEnvFiles() {
  const candidates = [
    process.env.ENV_FILE,
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env.local"),
    resolve(process.cwd(), "../../.env"),
  ].filter((v): v is string => Boolean(v));

  for (const file of candidates) {
    if (existsSync(file)) {
      config({ path: file, override: false });
    }
  }
}

loadEnvFiles();

const envSchema = z.object({
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().url(),
  HTTPS_PROXY: z.string().optional(),
  HTTP_PROXY: z.string().optional(),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.string().default("true"),
  S3_PUBLIC_BASE_URL: z.string().url(),
  GEMINI_API_KEY: z.string().min(10).optional(),
  GOOGLE_API_KEY: z.string().min(10).optional(),
  GEMINI_MOCK: z.string().optional(),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_IMAGE_MODEL: z.string().default("gemini-2.5-flash-image"),
  GEMINI_VIDEO_MODEL: z.string().default("veo-3.1-generate-preview"),
  GEMINI_VIDEO_SECONDS: z.coerce.number().int().min(1).max(15).default(5),
  GEMINI_VIDEO_RESOLUTION: z.string().default("720p"),
  VIDEO_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(600_000),
  // 火山引擎 AI MediaKit 视频画质增强（Bearer Token 鉴权，REST 接口）
  VOLC_API_KEY: z.string().optional(),
  VOLC_HOST: z.string().default("mediakit.cn-beijing.volces.com"),
  // 工具版本：standard（标准版，默认）| professional（专业版）
  VOLC_TOOL_VERSION: z.string().default("standard"),
  // 默认目标分辨率（240p~4k）；留空表示使用原始分辨率
  VOLC_RESOLUTION: z.string().default(""),
});

@Injectable()
export class EnvService {
  private readonly env = envSchema.parse(process.env);

  get redisUrl() {
    return this.env.REDIS_URL;
  }

  get redisConnection(): RedisOptions {
    const url = new URL(this.env.REDIS_URL);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
      tls: url.protocol === "rediss:" ? {} : undefined,
    };
  }

  get s3Endpoint() {
    return this.env.S3_ENDPOINT;
  }

  get proxyUrl() {
    return this.env.HTTPS_PROXY || this.env.HTTP_PROXY;
  }

  get s3Region() {
    return this.env.S3_REGION;
  }

  get s3AccessKey() {
    return this.env.S3_ACCESS_KEY;
  }

  get s3SecretKey() {
    return this.env.S3_SECRET_KEY;
  }

  get s3Bucket() {
    return this.env.S3_BUCKET;
  }

  get s3ForcePathStyle() {
    return this.env.S3_FORCE_PATH_STYLE.toLowerCase() === "true";
  }

  get s3PublicBaseUrl() {
    return this.env.S3_PUBLIC_BASE_URL;
  }

  get geminiApiKey() {
    return this.env.GEMINI_API_KEY || this.env.GOOGLE_API_KEY || "mock";
  }

  get geminiMock() {
    return this.env.GEMINI_MOCK?.toLowerCase() === "true";
  }

  get geminiBaseUrl() {
    return this.env.GEMINI_BASE_URL;
  }

  get geminiImageModel() {
    return this.env.GEMINI_IMAGE_MODEL;
  }

  get geminiVideoModel() {
    return this.env.GEMINI_VIDEO_MODEL;
  }

  get geminiVideoSeconds() {
    return this.env.GEMINI_VIDEO_SECONDS;
  }

  get geminiVideoResolution() {
    return this.env.GEMINI_VIDEO_RESOLUTION;
  }

  get videoDownloadTimeoutMs() {
    return this.env.VIDEO_DOWNLOAD_TIMEOUT_MS;
  }

  // ---- 火山引擎 AI MediaKit 画质增强 ----
  get volcApiKey() {
    return this.env.VOLC_API_KEY;
  }

  get volcHost() {
    return this.env.VOLC_HOST;
  }

  get volcToolVersion() {
    return this.env.VOLC_TOOL_VERSION;
  }

  get volcResolution() {
    return this.env.VOLC_RESOLUTION;
  }
}
