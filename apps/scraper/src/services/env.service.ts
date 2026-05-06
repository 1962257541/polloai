import { Injectable } from "@nestjs/common";
import { config } from "dotenv";
import { z } from "zod";
import { existsSync } from "fs";
import { resolve } from "path";
import { RedisOptions } from "bullmq";

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
  TIKTOK_BOOT_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "TIKTOK_BOOT_KEY 必须是 32 字节 base64",
    })
    .optional(),
});

@Injectable()
export class EnvService {
  private readonly env = envSchema.parse(process.env);

  get redisUrl(): string {
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

  get tiktokBootKey(): Buffer | null {
    if (!this.env.TIKTOK_BOOT_KEY) return null;
    return Buffer.from(this.env.TIKTOK_BOOT_KEY, "base64");
  }
}
