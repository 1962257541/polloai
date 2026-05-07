import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";
import { EnvService } from "./env.service";
import { BrowserPoolService } from "./browser-pool.service";

const HB_KEY = "tt:scraper:hb";
const HB_TTL_SEC = 30;
const HB_INTERVAL_MS = 10_000;

interface HeartbeatPayload {
  ts: number;
  activeBrowsers: number;
  poolSize: number;
  successRate: number | null;
}

/**
 * 每 10s 写一次心跳到 Redis（TTL 30s）。
 * activeBrowsers/poolSize 实时取自 BrowserPool；successRate 由 MonitorWorker 累加。
 */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly redis: IORedis;
  private timer?: NodeJS.Timeout;

  totalScrapesLastHour = 0;
  successScrapesLastHour = 0;

  constructor(
    private readonly env: EnvService,
    private readonly browserPool: BrowserPoolService,
  ) {
    this.redis = new IORedis(env.redisUrl);
  }

  async onModuleInit() {
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(() => undefined), HB_INTERVAL_MS);
    this.logger.log("Heartbeat started (10s interval)");
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.redis.del(HB_KEY).catch(() => undefined);
    await this.redis.quit();
  }

  private async tick(): Promise<void> {
    const successRate =
      this.totalScrapesLastHour > 0
        ? this.successScrapesLastHour / this.totalScrapesLastHour
        : null;
    const payload: HeartbeatPayload = {
      ts: Date.now(),
      activeBrowsers: this.browserPool.activeBrowsers,
      poolSize: this.browserPool.poolSize,
      successRate,
    };
    await this.redis.set(HB_KEY, JSON.stringify(payload), "EX", HB_TTL_SEC);
  }
}
