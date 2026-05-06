import { Injectable, Logger } from "@nestjs/common";
import { BrowserContext, Page, Response } from "playwright";
import { PrismaService } from "./prisma.service";
import { SystemConfigLoaderService } from "./system-config-loader.service";
import { BrowserPoolService } from "./browser-pool.service";

export interface ScrapedVideo {
  videoId: string;
  title: string | null;
  coverUrl: string | null;
  publishedAt: Date | null;
  playCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  collectCount: number;
  gmvCents: number;
  orderCount: number;
}

export interface ScrapeResult {
  followerCount: number;
  videoCount: number;
  totalGmvCents: number;
  totalCommissionCents: number;
  totalOrders: number;
  videos: ScrapedVideo[];
}

/**
 * 采集异常分类。
 */
class ScraperError extends Error {
  constructor(
    message: string,
    public readonly code: "timeout" | "cookie_expired" | "captcha" | "network" | "structure" | "unknown",
  ) {
    super(message);
  }
}

@Injectable()
export class AffiliateScraperService {
  private readonly logger = new Logger(AffiliateScraperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configLoader: SystemConfigLoaderService,
    private readonly browserPool: BrowserPoolService,
  ) {}

  async scrapeAccount(accountId: string): Promise<void> {
    const account = await this.prisma.tiktokAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      this.logger.warn(`Account ${accountId} not found`);
      return;
    }
    if (account.status === "disabled") {
      this.logger.log(`Account ${account.handle} disabled, skipping`);
      return;
    }

    const cookieKey = this.configLoader.cfg.cookieKey;
    if (!cookieKey) {
      throw new Error("Cookie 主密钥未配置");
    }

    let storageState: unknown;
    try {
      storageState = this.decryptStorageState(account, cookieKey);
    } catch (e) {
      this.logger.error(`解密 storageState 失败: ${(e as Error).message}`);
      await this.markStatus(accountId, "cookie_expired", "Cookie 解密失败，请重新上传");
      return;
    }

    await this.browserPool.acquire();
    const startTime = Date.now();
    let context: BrowserContext | null = null;

    try {
      const browser = this.browserPool.getBrowser();
      context = await browser.newContext({
        storageState: storageState as any,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });

      const result = await this.runScrape(context, account.handle);
      await this.saveResult(accountId, result);

      const elapsed = Date.now() - startTime;
      this.logger.log(`Scraped ${account.handle} in ${elapsed}ms, videos=${result.videos.length}`);
    } catch (e) {
      const err = e instanceof ScraperError ? e : new ScraperError((e as Error).message, "unknown");
      this.logger.error(`Scrape failed for ${account.handle}: [${err.code}] ${err.message}`);

      const statusMap: Record<string, string> = {
        timeout: "error",
        cookie_expired: "cookie_expired",
        captcha: "captcha_blocked",
        network: "error",
        structure: "error",
        unknown: "error",
      };
      await this.markStatus(accountId, statusMap[err.code] || "error", `${err.code}: ${err.message}`);
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
      this.browserPool.release();
    }
  }

  // ========== 核心抓取流程 ==========

  private async runScrape(context: BrowserContext, handle: string): Promise<ScrapeResult> {
    const page = await context.newPage();
    const timeout = this.configLoader.cfg.scrapeTimeoutMs;

    try {
      // 1. 抓取视频列表
      const { videos: videoList, followerCount, videoCount } = await this.scrapeVideoList(page, handle, timeout);

      // 2. 抓取 Affiliate GMV
      let totalGmvCents = 0;
      let totalCommissionCents = 0;
      let totalOrders = 0;

      try {
        const affiliate = await this.scrapeAffiliate(context, handle, timeout);
        totalGmvCents = affiliate.totalGmvCents;
        totalCommissionCents = affiliate.totalCommissionCents;
        totalOrders = affiliate.totalOrders;
      } catch (e) {
        this.logger.warn(`Affiliate scrape skipped for ${handle}: ${(e as Error).message}`);
      }

      return {
        followerCount,
        videoCount: videoCount ?? videoList.length,
        totalGmvCents,
        totalCommissionCents,
        totalOrders,
        videos: videoList,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * 抓取主页视频列表。
   * 策略：先尝试 XHR intercept，失败后回退到页面 script JSON 提取。
   */
  private async scrapeVideoList(
    page: Page,
    handle: string,
    timeout: number,
  ): Promise<{ videos: ScrapedVideo[]; followerCount: number; videoCount: number }> {
    const profileUrl = `https://www.tiktok.com/${handle}`;
    const xhrVideos: ScrapedVideo[] = [];
    let followerCount = 0;
    let videoCount = 0;

    // 注册 XHR 拦截
    const xhrHandler = async (response: Response) => {
      const url = response.url();
      if (!url.includes("/api/post/item_list/") && !url.includes("itemList")) return;
      try {
        if (!response.ok()) return;
        const data = await response.json();
        const items = data?.itemList || data?.itemList || data?.items || [];
        for (const item of items) {
          const v = this.normalizeVideoItem(item);
          if (v.videoId) xhrVideos.push(v);
        }
      } catch {
        // ignore parse errors
      }
    };
    page.on("response", xhrHandler);

    // 访问主页
    await page.goto(profileUrl, { waitUntil: "networkidle", timeout }).catch((e) => {
      throw new ScraperError(`主页访问失败: ${e.message}`, "network");
    });

    // 等待首次内容出现
    await page.waitForTimeout(2000);

    // 提取粉丝数
    try {
      const fc = await page.locator('[data-e2e="profile-follower-count"]').textContent({ timeout: 3000 });
      if (fc) followerCount = this.parseCount(fc);
    } catch {
      // fallback: 从页面 JSON
      const jsonMatch = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const text = s.textContent || "";
          if (text.includes('"followerCount"') || text.includes('"follower_count"')) {
            const m = text.match(/"followerCount"\s*[:=]\s*(\d+)/) || text.match(/"follower_count"\s*[:=]\s*(\d+)/);
            if (m) return Number(m[1]);
          }
        }
        return 0;
      });
      if (jsonMatch) followerCount = jsonMatch;
    }

    // 滚动加载直到没有新内容
    let lastLength = 0;
    let stallCount = 0;
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);

      if (xhrVideos.length === lastLength) {
        stallCount++;
        if (stallCount >= 2) break;
      } else {
        stallCount = 0;
        lastLength = xhrVideos.length;
      }
    }

    page.off("response", xhrHandler);

    // 去重（同一 videoId 保留最新）
    const dedup = new Map<string, ScrapedVideo>();
    for (const v of xhrVideos) dedup.set(v.videoId, v);
    const videos = Array.from(dedup.values());

    this.logger.log(`XHR intercept: ${videos.length} videos for ${handle}`);

    // 如果 XHR 拦截为空，尝试 DOM fallback
    if (videos.length === 0) {
      this.logger.warn(`XHR empty for ${handle}, trying DOM fallback`);
      const domVideos = await this.scrapeVideoListFromDOM(page);
      if (domVideos.length > 0) {
        return { videos: domVideos, followerCount, videoCount: domVideos.length };
      }
    }

    // 尝试提取 videoCount
    try {
      const vc = await page.locator('[data-e2e="profile-video-count"]').textContent({ timeout: 2000 });
      if (vc) videoCount = this.parseCount(vc);
    } catch {
      videoCount = videos.length;
    }

    return { videos, followerCount, videoCount };
  }

  /**
   * DOM fallback：从页面 script 标签里的 JSON 提取。
   */
  private async scrapeVideoListFromDOM(page: Page): Promise<ScrapedVideo[]> {
    return page.evaluate(() => {
      const results: ScrapedVideo[] = [];
      const scripts = Array.from(document.querySelectorAll('script[id*="SIGI_STATE"]'));
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent || "{}");
          const itemModule = data.ItemModule || data.itemModule || {};
          for (const key of Object.keys(itemModule)) {
            const item = itemModule[key];
            const stats = item.stats || {};
            results.push({
              videoId: String(item.id || ""),
              title: item.desc || item.title || null,
              coverUrl: item.video?.cover || item.video?.dynamicCover || item.video?.originCover || null,
              publishedAt: item.createTime ? new Date(Number(item.createTime) * 1000) : null,
              playCount: Number(stats.playCount || 0),
              likeCount: Number(stats.diggCount || 0),
              commentCount: Number(stats.commentCount || 0),
              shareCount: Number(stats.shareCount || 0),
              collectCount: Number(stats.collectCount || 0),
              gmvCents: 0,
              orderCount: 0,
            });
          }
        } catch {
          // ignore
        }
      }
      return results;
    });
  }

  /**
   * Affiliate 后台抓取。
   * 策略：拦截后台 API 请求而非 DOM 选择器。
   */
  private async scrapeAffiliate(
    context: BrowserContext,
    handle: string,
    timeout: number,
  ): Promise<{ totalGmvCents: number; totalCommissionCents: number; totalOrders: number }> {
    const affiliatePage = await context.newPage();
    let gmvCents = 0;
    let commissionCents = 0;
    let orders = 0;

    const apiHandler = async (response: Response) => {
      const url = response.url();
      if (!url.includes("affiliate") && !url.includes("creator")) return;
      try {
        if (!response.ok()) return;
        const data = await response.json();
        // 常见字段路径
        const gmv =
          data?.data?.gmv || data?.data?.totalGmv || data?.gmv || data?.total_gmv || 0;
        const comm =
          data?.data?.commission || data?.data?.totalCommission || data?.commission || 0;
        const ord =
          data?.data?.orderCount || data?.data?.totalOrders || data?.order_count || 0;
        if (gmv) gmvCents = Math.round(Number(gmv) * 100);
        if (comm) commissionCents = Math.round(Number(comm) * 100);
        if (ord) orders = Number(ord);
      } catch {
        // ignore
      }
    };
    affiliatePage.on("response", apiHandler);

    try {
      const url = this.configLoader.cfg.affiliateOverviewUrl;
      await affiliatePage.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await affiliatePage.waitForTimeout(5000);
    } catch (e) {
      this.logger.warn(`Affiliate page load failed: ${(e as Error).message}`);
    } finally {
      affiliatePage.off("response", apiHandler);
      await affiliatePage.close().catch(() => undefined);
    }

    return { totalGmvCents: gmvCents, totalCommissionCents: commissionCents, totalOrders: orders };
  }

  // ========== 数据归一化 ==========

  private normalizeVideoItem(item: any): ScrapedVideo {
    const stats = item.stats || item.statsV2 || item.authorStats || {};
    return {
      videoId: String(item.id || item.video?.id || ""),
      title: item.desc || item.title || null,
      coverUrl:
        item.video?.cover ||
        item.video?.dynamicCover ||
        item.video?.originCover ||
        item.video?.reflowCover ||
        item.author?.avatarThumb ||
        null,
      publishedAt: item.createTime ? new Date(Number(item.createTime) * 1000) : null,
      playCount: Number(stats.playCount || stats.play_count || 0),
      likeCount: Number(stats.diggCount || stats.digg_count || 0),
      commentCount: Number(stats.commentCount || stats.comment_count || 0),
      shareCount: Number(stats.shareCount || stats.share_count || 0),
      collectCount: Number(stats.collectCount || stats.collect_count || 0),
      gmvCents: 0,
      orderCount: 0,
    };
  }

  // ========== 数据库写入 ==========

  private async saveResult(accountId: string, result: ScrapeResult): Promise<void> {
    const now = new Date();

    for (const v of result.videos) {
      const upserted = await this.prisma.tiktokVideo.upsert({
        where: { accountId_videoId: { accountId, videoId: v.videoId } },
        create: {
          accountId,
          videoId: v.videoId,
          title: v.title,
          coverUrl: v.coverUrl,
          publishedAt: v.publishedAt,
          playCount: BigInt(v.playCount),
          likeCount: BigInt(v.likeCount),
          commentCount: BigInt(v.commentCount),
          shareCount: BigInt(v.shareCount),
          collectCount: BigInt(v.collectCount),
          gmvCents: BigInt(v.gmvCents),
          orderCount: v.orderCount,
          scrapedAt: now,
        },
        update: {
          title: v.title,
          coverUrl: v.coverUrl,
          publishedAt: v.publishedAt,
          playCount: BigInt(v.playCount),
          likeCount: BigInt(v.likeCount),
          commentCount: BigInt(v.commentCount),
          shareCount: BigInt(v.shareCount),
          collectCount: BigInt(v.collectCount),
          gmvCents: BigInt(v.gmvCents),
          orderCount: v.orderCount,
          scrapedAt: now,
        },
      });

      await this.prisma.tiktokVideoMetric.create({
        data: {
          videoId: upserted.id,
          playCount: BigInt(v.playCount),
          likeCount: BigInt(v.likeCount),
          commentCount: BigInt(v.commentCount),
          shareCount: BigInt(v.shareCount),
          collectCount: BigInt(v.collectCount),
          gmvCents: BigInt(v.gmvCents),
          orderCount: v.orderCount,
        },
      });
    }

    await this.prisma.tiktokAccount.update({
      where: { id: accountId },
      data: {
        followerCount: result.followerCount,
        videoCount: result.videoCount,
        totalGmvCents: BigInt(result.totalGmvCents),
        totalCommissionCents: BigInt(result.totalCommissionCents),
        totalOrders: result.totalOrders,
        lastScrapedAt: now,
        status: "active",
        lastErrorMessage: null,
        lastErrorAt: null,
      },
    });
  }

  // ========== 工具方法 ==========

  private decryptStorageState(account: any, cookieKey: Buffer): unknown {
    if (!account.storageStateEnc || !account.storageStateIv || !account.storageStateTag) {
      throw new Error("storageState 为空");
    }
    const { createDecipheriv } = require("node:crypto");
    const decipher = createDecipheriv("aes-256-gcm", cookieKey, Buffer.from(account.storageStateIv));
    decipher.setAuthTag(Buffer.from(account.storageStateTag));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(account.storageStateEnc)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  }

  private async markStatus(accountId: string, status: string, message: string): Promise<void> {
    await this.prisma.tiktokAccount.update({
      where: { id: accountId },
      data: {
        status: status as any,
        lastErrorMessage: message,
        lastErrorAt: new Date(),
      },
    });
  }

  private parseCount(text: string): number {
    const cleaned = text.replace(/,/g, "").toLowerCase().trim();
    if (cleaned.endsWith("k")) return Math.round(Number(cleaned.slice(0, -1)) * 1000);
    if (cleaned.endsWith("m")) return Math.round(Number(cleaned.slice(0, -1)) * 1000000);
    return Number(cleaned) || 0;
  }
}
