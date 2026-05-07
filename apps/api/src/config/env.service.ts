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
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().optional(),
  APP_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(8),
  JWT_EXPIRES_IN: z.string().default("7d"),
  CORS_ORIGINS: z.string().default("*"),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.string().default("true"),
  S3_PUBLIC_BASE_URL: z.string().url(),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_IMAGE_MODEL: z.string().default("gemini-2.5-flash-image"),
  GEMINI_VIDEO_MODEL: z.string().default("veo-3.1-generate-preview"),
  GEMINI_VIDEO_SECONDS: z.coerce.number().int().min(4).max(8).default(4),
  GEMINI_VIDEO_RESOLUTION: z.string().default("720p"),
});

export type Env = z.infer<typeof envSchema>;

@Injectable()
export class EnvService {
  private readonly env: Env;

  constructor() {
    this.env = envSchema.parse(process.env);
  }

  get appPort() {
    return this.env.PORT ?? this.env.APP_PORT;
  }

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

  get jwtSecret() {
    return this.env.JWT_SECRET;
  }

  get jwtExpiresIn() {
    return this.env.JWT_EXPIRES_IN;
  }

  get corsOrigins() {
    return this.env.CORS_ORIGINS.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  get s3Endpoint() {
    return this.env.S3_ENDPOINT;
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

}
