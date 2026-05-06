import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createDecipheriv } from "node:crypto";
import IORedis from "ioredis";
import { EnvService } from "./env.service";
import { PrismaService } from "./prisma.service";

const CHANNEL = "system-config:changed";

const TIKTOK_KEYS = {
  cookieKey: "tiktok.cookieKey",
  affiliateOverviewUrl: "tiktok.affiliateOverviewUrl",
  scrapeTimeoutMs: "tiktok.scrapeTimeoutMs",
  browserPoolSize: "tiktok.browserPoolSize",
  defaultIntervalMin: "tiktok.defaultIntervalMin",
} as const;

const DEFAULTS = {
  affiliateOverviewUrl: "https://affiliate.tiktok.com/connection/creator",
  scrapeTimeoutMs: 90_000,
  browserPoolSize: 5,
  defaultIntervalMin: 60,
} as const;

export interface TiktokScraperConfig {
  affiliateOverviewUrl: string;
  scrapeTimeoutMs: number;
  browserPoolSize: number;
  defaultIntervalMin: number;
  cookieKey: Buffer | null;
}

/**
 * 启动时从 SystemConfig 表加载 TikTok 配置；
 * 订阅 Redis Pub/Sub `system-config:changed` 频道，配置变更时热重载。
 *
 * 业务侧（BrowserPool / AffiliateScraper）通过 cfg.cookieKey 加解密 storage_state。
 */
@Injectable()
export class SystemConfigLoaderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemConfigLoaderService.name);
  private readonly subscriber: IORedis;

  cfg: TiktokScraperConfig = {
    ...DEFAULTS,
    cookieKey: null,
  };

  constructor(
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
  ) {
    this.subscriber = new IORedis(env.redisUrl, { enableReadyCheck: false });
  }

  async onModuleInit() {
    await this.reload();

    this.subscriber.on("message", async (channel, payload) => {
      if (channel !== CHANNEL) return;
      try {
        const parsed = JSON.parse(payload) as { category?: string };
        if (parsed.category === "tiktok") {
          this.logger.log("Detected tiktok config change, reloading...");
          await this.reload();
        }
      } catch {
        // ignore
      }
    });
    await this.subscriber.subscribe(CHANNEL);
  }

  async onModuleDestroy() {
    await this.subscriber.quit();
  }

  private async reload(): Promise<void> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { category: "tiktok" },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r]));
    const cookieRow = map[TIKTOK_KEYS.cookieKey];

    let cookieKey: Buffer | null = null;
    if (cookieRow?.valueEnc && cookieRow.valueIv && cookieRow.valueTag) {
      const bootKey = this.env.tiktokBootKey;
      if (!bootKey) {
        this.logger.warn("TIKTOK_BOOT_KEY 未配置，无法解密 tiktok.cookieKey");
      } else {
        try {
          const decipher = createDecipheriv(
            "aes-256-gcm",
            bootKey,
            Buffer.from(cookieRow.valueIv),
          );
          decipher.setAuthTag(Buffer.from(cookieRow.valueTag));
          cookieKey = Buffer.concat([
            decipher.update(Buffer.from(cookieRow.valueEnc)),
            decipher.final(),
          ]);
        } catch (e) {
          this.logger.error("解密 tiktok.cookieKey 失败：" + (e as Error).message);
        }
      }
    }

    const parseInt10 = (v: string | null | undefined, fallback: number) => {
      if (!v) return fallback;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : fallback;
    };

    this.cfg = {
      affiliateOverviewUrl:
        map[TIKTOK_KEYS.affiliateOverviewUrl]?.valuePlain ?? DEFAULTS.affiliateOverviewUrl,
      scrapeTimeoutMs: parseInt10(
        map[TIKTOK_KEYS.scrapeTimeoutMs]?.valuePlain,
        DEFAULTS.scrapeTimeoutMs,
      ),
      browserPoolSize: parseInt10(
        map[TIKTOK_KEYS.browserPoolSize]?.valuePlain,
        DEFAULTS.browserPoolSize,
      ),
      defaultIntervalMin: parseInt10(
        map[TIKTOK_KEYS.defaultIntervalMin]?.valuePlain,
        DEFAULTS.defaultIntervalMin,
      ),
      cookieKey,
    };
    this.logger.log(
      `Tiktok config loaded: poolSize=${this.cfg.browserPoolSize}, interval=${this.cfg.defaultIntervalMin}min, cookieKey=${cookieKey ? "configured" : "missing"}`,
    );
  }
}
