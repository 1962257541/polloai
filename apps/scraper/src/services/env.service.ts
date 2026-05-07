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
  TIKTOK_SCRAPER_HEADLESS: z.string().optional(),
  TIKTOK_SCRAPER_PROXY: z.string().optional(),
  TIKTOK_SCRAPER_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(5),
  TIKTOK_SCRAPER_TIMEOUT_MS: z.coerce.number().int().min(20_000).max(300_000).default(90_000),
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

  get scraperHeadless(): boolean {
    return this.env.TIKTOK_SCRAPER_HEADLESS !== "false";
  }

  /** 代理优先级：TIKTOK_SCRAPER_PROXY > all_proxy > ALL_PROXY > HTTPS_PROXY */
  get scraperProxy(): string | undefined {
    return (
      this.env.TIKTOK_SCRAPER_PROXY ||
      process.env.all_proxy ||
      process.env.ALL_PROXY ||
      process.env.HTTPS_PROXY ||
      undefined
    );
  }

  get scraperPoolSize(): number {
    return this.env.TIKTOK_SCRAPER_POOL_SIZE;
  }

  get scraperTimeoutMs(): number {
    return this.env.TIKTOK_SCRAPER_TIMEOUT_MS;
  }
}
