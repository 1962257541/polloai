import { Controller, Get, UseGuards } from "@nestjs/common";
import IORedis from "ioredis";
import { EnvService } from "../config/env.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";

interface ScraperHealth {
  online: boolean;
  ageSeconds: number | null;
  activeBrowsers: number;
  poolSize: number;
  successRate: number | null;
}

@Controller("tiktok")
@UseGuards(JwtAuthGuard, RolesGuard)
export class TiktokHealthController {
  constructor(private readonly env: EnvService) {}

  @Get("health")
  @Roles("admin")
  async getHealth(): Promise<ScraperHealth> {
    const redis = new IORedis(this.env.redisUrl);
    try {
      const raw = await redis.get("tt:scraper:hb");
      if (!raw) {
        return { online: false, ageSeconds: null, activeBrowsers: 0, poolSize: 0, successRate: null };
      }
      const data = JSON.parse(raw) as {
        ts: number;
        activeBrowsers?: number;
        poolSize?: number;
        successRate?: number | null;
      };
      const ageSeconds = Math.round((Date.now() - data.ts) / 1000);
      return {
        online: ageSeconds <= 60,
        ageSeconds,
        activeBrowsers: data.activeBrowsers ?? 0,
        poolSize: data.poolSize ?? 0,
        successRate: data.successRate ?? null,
      };
    } catch {
      return { online: false, ageSeconds: null, activeBrowsers: 0, poolSize: 0, successRate: null };
    } finally {
      await redis.quit();
    }
  }
}
