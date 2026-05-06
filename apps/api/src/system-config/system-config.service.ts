import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import IORedis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { EnvService } from "../config/env.service";
import { SystemConfigCryptoService } from "./crypto.service";
import {
  TIKTOK_CONFIG_CATEGORY,
  TIKTOK_CONFIG_DEFAULTS,
  TIKTOK_CONFIG_KEYS,
  SYSTEM_CONFIG_CHANGED_CHANNEL,
} from "./system-config.constants";
import { UpdateTiktokConfigDto } from "./dto/update-tiktok-config.dto";

export interface CookieKeyStatus {
  configured: boolean;
  byteLength?: number;
  updatedAt?: Date;
}

export interface TiktokConfigDto {
  cookieKey: CookieKeyStatus;
  affiliateOverviewUrl: string;
  scrapeTimeoutMs: number;
  browserPoolSize: number;
  defaultIntervalMin: number;
}

@Injectable()
export class SystemConfigService implements OnModuleDestroy {
  private readonly publisher: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly crypto: SystemConfigCryptoService,
  ) {
    this.publisher = new IORedis(env.redisUrl);
  }

  async onModuleDestroy() {
    await this.publisher.quit();
  }

  /** 配置页加载：敏感字段脱敏返回，其它字段含默认值 */
  async getTiktokConfig(): Promise<TiktokConfigDto> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { category: TIKTOK_CONFIG_CATEGORY },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r]));
    const cookieRow = map[TIKTOK_CONFIG_KEYS.cookieKey];

    return {
      cookieKey: cookieRow
        ? {
            configured: true,
            byteLength: cookieRow.byteLength ?? undefined,
            updatedAt: cookieRow.updatedAt,
          }
        : { configured: false },
      affiliateOverviewUrl:
        map[TIKTOK_CONFIG_KEYS.affiliateOverviewUrl]?.valuePlain ??
        TIKTOK_CONFIG_DEFAULTS.affiliateOverviewUrl,
      scrapeTimeoutMs: this.parseInt(
        map[TIKTOK_CONFIG_KEYS.scrapeTimeoutMs]?.valuePlain,
        TIKTOK_CONFIG_DEFAULTS.scrapeTimeoutMs,
      ),
      browserPoolSize: this.parseInt(
        map[TIKTOK_CONFIG_KEYS.browserPoolSize]?.valuePlain,
        TIKTOK_CONFIG_DEFAULTS.browserPoolSize,
      ),
      defaultIntervalMin: this.parseInt(
        map[TIKTOK_CONFIG_KEYS.defaultIntervalMin]?.valuePlain,
        TIKTOK_CONFIG_DEFAULTS.defaultIntervalMin,
      ),
    };
  }

  /** 批量更新非敏感配置 */
  async updateTiktokConfig(
    dto: UpdateTiktokConfigDto,
    actorId: string,
  ): Promise<TiktokConfigDto> {
    const updates: Array<[string, string]> = [];
    if (dto.affiliateOverviewUrl !== undefined)
      updates.push([
        TIKTOK_CONFIG_KEYS.affiliateOverviewUrl,
        dto.affiliateOverviewUrl,
      ]);
    if (dto.scrapeTimeoutMs !== undefined)
      updates.push([
        TIKTOK_CONFIG_KEYS.scrapeTimeoutMs,
        String(dto.scrapeTimeoutMs),
      ]);
    if (dto.browserPoolSize !== undefined)
      updates.push([
        TIKTOK_CONFIG_KEYS.browserPoolSize,
        String(dto.browserPoolSize),
      ]);
    if (dto.defaultIntervalMin !== undefined)
      updates.push([
        TIKTOK_CONFIG_KEYS.defaultIntervalMin,
        String(dto.defaultIntervalMin),
      ]);

    for (const [key, value] of updates) {
      await this.prisma.systemConfig.upsert({
        where: { key },
        create: {
          key,
          category: TIKTOK_CONFIG_CATEGORY,
          isSecret: false,
          valuePlain: value,
          updatedBy: actorId,
        },
        update: { valuePlain: value, updatedBy: actorId },
      });
    }

    if (updates.length > 0) await this.notifyChange();
    return this.getTiktokConfig();
  }

  /**
   * 生成新的 32 字节 Cookie 主密钥，用 BOOT_KEY 加密入库。
   * 旋转后所有现有 storage_state 因密钥不匹配无法解密 →
   * 把所有非 disabled 的账号置为 cookie_expired，提示重新上传。
   */
  async rotateTiktokCookieKey(actorId: string): Promise<CookieKeyStatus> {
    const newKey = randomBytes(32);
    const blob = this.crypto.encryptWithBoot(newKey);
    const enc = new Uint8Array(blob.enc);
    const iv = new Uint8Array(blob.iv);
    const tag = new Uint8Array(blob.tag);

    const row = await this.prisma.systemConfig.upsert({
      where: { key: TIKTOK_CONFIG_KEYS.cookieKey },
      create: {
        key: TIKTOK_CONFIG_KEYS.cookieKey,
        category: TIKTOK_CONFIG_CATEGORY,
        isSecret: true,
        valueEnc: enc,
        valueIv: iv,
        valueTag: tag,
        byteLength: 32,
        updatedBy: actorId,
      },
      update: {
        valueEnc: enc,
        valueIv: iv,
        valueTag: tag,
        byteLength: 32,
        updatedBy: actorId,
      },
    });

    await this.prisma.tiktokAccount.updateMany({
      where: { status: { not: "disabled" } },
      data: {
        status: "cookie_expired",
        lastErrorMessage: "Cookie 主密钥已轮换，请重新上传 storage_state",
        lastErrorAt: new Date(),
      },
    });

    await this.notifyChange();
    return { configured: true, byteLength: 32, updatedAt: row.updatedAt };
  }

  async resetTiktokCookieKey(actorId: string): Promise<void> {
    await this.prisma.systemConfig
      .delete({ where: { key: TIKTOK_CONFIG_KEYS.cookieKey } })
      .catch(() => undefined);
    await this.prisma.tiktokAccount.updateMany({
      where: { status: { not: "disabled" } },
      data: {
        status: "cookie_expired",
        lastErrorMessage: "Cookie 主密钥已重置，请重新生成并上传 storage_state",
        lastErrorAt: new Date(),
      },
    });
    void actorId;
    await this.notifyChange();
  }

  /**
   * 解密 Cookie 主密钥（返回 32 字节 Buffer）。
   * 业务模块（TiktokModule / Scraper）调用此方法加解密 storage_state。
   */
  async getCookieKeyBuffer(): Promise<Buffer | null> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: TIKTOK_CONFIG_KEYS.cookieKey },
    });
    if (!row || !row.valueEnc || !row.valueIv || !row.valueTag) return null;
    return this.crypto.decryptWithBoot({
      enc: Buffer.from(row.valueEnc),
      iv: Buffer.from(row.valueIv),
      tag: Buffer.from(row.valueTag),
    });
  }

  private parseInt(value: string | null | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  private async notifyChange(): Promise<void> {
    await this.publisher.publish(
      SYSTEM_CONFIG_CHANGED_CHANNEL,
      JSON.stringify({ category: TIKTOK_CONFIG_CATEGORY }),
    );
  }
}
