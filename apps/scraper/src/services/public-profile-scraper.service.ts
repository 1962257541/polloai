import { Injectable, Logger } from "@nestjs/common";
import { BrowserContext, Page, Response } from "playwright";
import { PrismaService } from "./prisma.service";
import { BrowserPoolService } from "./browser-pool.service";
import { EnvService } from "./env.service";

export interface ScrapedVideo {
  videoId: string;
  title: string | null;
  coverUrl: string | null;
  videoUrl: string | null;
  durationMs: number;
  publishedAt: Date | null;
  playCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  collectCount: number;
}

export interface ScrapedProfile {
  uid: string;
  secUid: string;
  uniqueId: string;
  nickname: string;
  avatarUrl: string;
  bioSignature: string;
  followerCount: number;
  followingCount: number;
  heartCount: bigint;
  videoCount: number;
  videos: ScrapedVideo[];
}

class ScraperError extends Error {
  constructor(
    message: string,
    public readonly code: "not_found" | "rate_limited" | "network" | "structure" | "unknown",
  ) {
    super(message);
  }
}

@Injectable()
export class PublicProfileScraperService {
  private readonly logger = new Logger(PublicProfileScraperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly browserPool: BrowserPoolService,
    private readonly env: EnvService,
  ) {}

  async scrapeAccount(accountId: string): Promise<void> {
    const account = await this.prisma.tiktokAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      this.logger.warn(`Account ${accountId} not found`);
      return;
    }
    if (account.status === "disabled") {
      this.logger.log(`Account ${account.handle ?? account.uid} disabled, skipping`);
      return;
    }

    await this.browserPool.acquire();
    const startTime = Date.now();
    let context: BrowserContext | null = null;

    try {
      const browser = this.browserPool.getBrowser();
      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
      });

      const profile = await this.runScrape(context, account.handle, account.uid);
      await this.saveProfile(accountId, profile);

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `Scraped @${profile.uniqueId} in ${elapsed}ms: followers=${profile.followerCount}, ` +
          `videos=${profile.videos.length}/${profile.videoCount}`,
      );
    } catch (e) {
      const err = e instanceof ScraperError ? e : new ScraperError((e as Error).message, "unknown");
      this.logger.error(
        `Scrape failed for ${account.handle ?? account.uid}: [${err.code}] ${err.message}`,
      );

      const statusMap: Record<string, "not_found" | "rate_limited" | "error"> = {
        not_found: "not_found",
        rate_limited: "rate_limited",
        network: "error",
        structure: "error",
        unknown: "error",
      };
      await this.markStatus(accountId, statusMap[err.code] || "error", `${err.code}: ${err.message}`);
    } finally {
      if (context) await context.close().catch(() => undefined);
      this.browserPool.release();
    }
  }

  // ========== 核心抓取 ==========

  private async runScrape(
    context: BrowserContext,
    handle: string | null,
    uid: string | null,
  ): Promise<ScrapedProfile> {
    const page = await context.newPage();
    const timeout = this.env.scraperTimeoutMs;

    try {
      // 决定目标 URL
      let profileUrl: string;
      if (handle) {
        const h = handle.startsWith("@") ? handle.slice(1) : handle;
        profileUrl = `https://www.tiktok.com/@${h}`;
      } else if (uid) {
        // 尝试通过 share link 重定向：https://www.tiktok.com/share/user/{uid} → /@actual
        profileUrl = `https://www.tiktok.com/share/user/${uid}`;
      } else {
        throw new ScraperError("账号既无 handle 也无 uid", "structure");
      }

      // XHR 拦截 item_list
      const xhrVideos: ScrapedVideo[] = [];
      const xhrHandler = async (response: Response) => {
        const url = response.url();
        if (!url.includes("/api/post/item_list")) return;
        try {
          if (!response.ok()) return;
          const text = await response.text();
          if (!text) return;
          const data = JSON.parse(text);
          const items = data?.itemList || data?.items || [];
          for (const item of items) {
            const v = this.normalizeVideoItem(item);
            if (v.videoId) xhrVideos.push(v);
          }
        } catch {
          // ignore
        }
      };
      page.on("response", xhrHandler);

      // 访问主页（share link 会 302 → @handle）
      try {
        await page.goto(profileUrl, { waitUntil: "networkidle", timeout: Math.min(timeout, 45_000) });
      } catch {
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout }).catch((e) => {
          throw new ScraperError(`主页访问失败: ${(e as Error).message}`, "network");
        });
      }
      await page.waitForTimeout(3500);

      const finalUrl = page.url();
      // 如果 share/user/{uid} 没重定向（比如返 404 或登录墙），URL 不会是 /@xxx
      if (!finalUrl.match(/\/@[A-Za-z0-9._]+/)) {
        throw new ScraperError(`无法定位账号主页: ${finalUrl}`, "not_found");
      }

      // SSR 解析
      const ssr = await this.extractFromUniversalData(page);
      if (!ssr.uniqueId && !ssr.secUid) {
        throw new ScraperError("SSR 解析失败：未找到 userInfo", "structure");
      }

      // 滚动触发 XHR 分页
      await page.mouse.move(640, 400).catch(() => undefined);
      await page.waitForTimeout(800);
      const maxScrolls = ssr.itemListVideos.length > 0 ? 4 : 8;
      let lastLen = xhrVideos.length;
      let stall = 0;
      for (let i = 0; i < maxScrolls; i++) {
        if (i % 2 === 0) {
          await page.evaluate(() => window.scrollBy(0, 1500));
        } else {
          await page.keyboard.press("End").catch(() => undefined);
        }
        await page.waitForTimeout(2500);
        if (xhrVideos.length === lastLen) {
          stall++;
          if (stall >= 3) break;
        } else {
          stall = 0;
          lastLen = xhrVideos.length;
        }
      }
      page.off("response", xhrHandler);

      // 合并去重
      const dedup = new Map<string, ScrapedVideo>();
      for (const v of ssr.itemListVideos) dedup.set(v.videoId, v);
      for (const v of xhrVideos) dedup.set(v.videoId, v);
      const videos = Array.from(dedup.values());

      this.logger.log(
        `${ssr.uniqueId}: SSR=${ssr.itemListVideos.length}, XHR=${xhrVideos.length}, merged=${videos.length}`,
      );

      // 视频列表为空但 stats.videoCount>0 → rate limited（TikTok 反爬丢空 body）
      if (videos.length === 0 && ssr.videoCount > 0) {
        // 不立即报错；保存账号级 stats，但标记 rate_limited 让用户感知
        // 让 saveProfile 写入，状态由 saveProfile 的逻辑判断
      }

      return {
        uid: String(ssr.uid || ""),
        secUid: ssr.secUid,
        uniqueId: ssr.uniqueId,
        nickname: ssr.nickname,
        avatarUrl: ssr.avatarUrl,
        bioSignature: ssr.bioSignature,
        followerCount: ssr.followerCount,
        followingCount: ssr.followingCount,
        heartCount: ssr.heartCount,
        videoCount: ssr.videoCount,
        videos,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * 从 `__UNIVERSAL_DATA_FOR_REHYDRATION__` 取出 user / stats / itemList。
   */
  private async extractFromUniversalData(page: Page): Promise<{
    uid: string;
    secUid: string;
    uniqueId: string;
    nickname: string;
    avatarUrl: string;
    bioSignature: string;
    followerCount: number;
    followingCount: number;
    heartCount: bigint;
    videoCount: number;
    itemListVideos: ScrapedVideo[];
  }> {
    const raw = await page.evaluate(() => {
      const tag = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!tag) return null;
      try {
        const root = JSON.parse(tag.textContent || "{}");
        const userInfo = root.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo;
        if (!userInfo) return null;
        const user = userInfo.user || {};
        const stats = userInfo.stats || userInfo.statsV2 || {};
        const itemList: any[] = Array.isArray(userInfo.itemList) ? userInfo.itemList : [];
        return {
          user: {
            id: String(user.id || ""),
            secUid: String(user.secUid || ""),
            uniqueId: String(user.uniqueId || ""),
            nickname: String(user.nickname || ""),
            avatarLarger: String(user.avatarLarger || user.avatarMedium || user.avatarThumb || ""),
            signature: String(user.signature || ""),
          },
          stats: {
            followerCount: Number(stats.followerCount || 0),
            followingCount: Number(stats.followingCount || 0),
            heartCount: String(stats.heartCount || stats.heart || "0"),
            videoCount: Number(stats.videoCount || 0),
          },
          itemList: itemList.map((item: any) => {
            const s = item.stats || item.statsV2 || {};
            return {
              id: String(item.id || ""),
              desc: item.desc || "",
              cover: item.video?.cover || item.video?.dynamicCover || item.video?.originCover || "",
              playAddr: item.video?.playAddr || "",
              duration: Number(item.video?.duration || 0), // seconds
              createTime: Number(item.createTime || 0),
              playCount: Number(s.playCount || s.play_count || 0),
              likeCount: Number(s.diggCount || s.digg_count || 0),
              commentCount: Number(s.commentCount || s.comment_count || 0),
              shareCount: Number(s.shareCount || s.share_count || 0),
              collectCount: Number(s.collectCount || s.collect_count || 0),
            };
          }),
        };
      } catch {
        return null;
      }
    });

    if (!raw) {
      return {
        uid: "",
        secUid: "",
        uniqueId: "",
        nickname: "",
        avatarUrl: "",
        bioSignature: "",
        followerCount: 0,
        followingCount: 0,
        heartCount: 0n,
        videoCount: 0,
        itemListVideos: [],
      };
    }

    return {
      uid: raw.user.id,
      secUid: raw.user.secUid,
      uniqueId: raw.user.uniqueId,
      nickname: raw.user.nickname,
      avatarUrl: raw.user.avatarLarger,
      bioSignature: raw.user.signature,
      followerCount: raw.stats.followerCount,
      followingCount: raw.stats.followingCount,
      heartCount: BigInt(raw.stats.heartCount || "0"),
      videoCount: raw.stats.videoCount,
      itemListVideos: raw.itemList.map((it) => this.normalizeFromSsr(it)),
    };
  }

  private normalizeVideoItem(item: any): ScrapedVideo {
    const s = item.stats || item.statsV2 || item.authorStats || {};
    return {
      videoId: String(item.id || item.video?.id || ""),
      title: item.desc || item.title || null,
      coverUrl:
        item.video?.cover ||
        item.video?.dynamicCover ||
        item.video?.originCover ||
        item.video?.reflowCover ||
        null,
      videoUrl: item.video?.playAddr || null,
      durationMs: Math.round(Number(item.video?.duration || 0) * 1000),
      publishedAt: item.createTime ? new Date(Number(item.createTime) * 1000) : null,
      playCount: Number(s.playCount || s.play_count || 0),
      likeCount: Number(s.diggCount || s.digg_count || 0),
      commentCount: Number(s.commentCount || s.comment_count || 0),
      shareCount: Number(s.shareCount || s.share_count || 0),
      collectCount: Number(s.collectCount || s.collect_count || 0),
    };
  }

  private normalizeFromSsr(it: {
    id: string;
    desc: string;
    cover: string;
    playAddr: string;
    duration: number;
    createTime: number;
    playCount: number;
    likeCount: number;
    commentCount: number;
    shareCount: number;
    collectCount: number;
  }): ScrapedVideo {
    return {
      videoId: it.id,
      title: it.desc || null,
      coverUrl: it.cover || null,
      videoUrl: it.playAddr || null,
      durationMs: Math.round(it.duration * 1000),
      publishedAt: it.createTime ? new Date(it.createTime * 1000) : null,
      playCount: it.playCount,
      likeCount: it.likeCount,
      commentCount: it.commentCount,
      shareCount: it.shareCount,
      collectCount: it.collectCount,
    };
  }

  // ========== DB ==========

  /**
   * 同一 TikTok 用户被以 handle / UID 两种方式创建为两条 record 时，
   * 抓取后用 secUid 找到所有同 TikTok 账号的 records，
   * 选 createdAt 最早的为 primary，把其他兄弟的非空手动字段 merge 进去 + 删除兄弟。
   * 返回最终要写入的 targetId（可能不是传入的 accountId）。
   */
  private async dedupBySecUid(accountId: string, secUid: string): Promise<string> {
    if (!secUid) return accountId;
    const all = await this.prisma.tiktokAccount.findMany({
      where: { secUid },
      orderBy: { createdAt: "asc" },
    });
    if (all.length <= 1) return accountId;

    const primary = all[0];
    const others = all.slice(1);

    // 把兄弟的非空手动字段 merge 进 primary（不覆盖 primary 已有值）
    const mergeData: {
      salesTag?: string;
      category?: string;
      region?: string;
      note?: string;
    } = {};
    for (const sib of others) {
      if (sib.salesTag && !primary.salesTag && !mergeData.salesTag) mergeData.salesTag = sib.salesTag;
      if (sib.category && !primary.category && !mergeData.category) mergeData.category = sib.category;
      if (sib.region && !primary.region && !mergeData.region) mergeData.region = sib.region;
      if (sib.note && !primary.note && !mergeData.note) mergeData.note = sib.note;
    }
    if (Object.keys(mergeData).length > 0) {
      await this.prisma.tiktokAccount
        .update({ where: { id: primary.id }, data: mergeData })
        .catch(() => undefined);
    }

    // 删除兄弟（cascade 删它们的 videos / metrics）
    for (const sib of others) {
      await this.prisma.tiktokAccount
        .delete({ where: { id: sib.id } })
        .catch(() => undefined);
    }

    this.logger.log(
      `Dedup: collapsed ${others.length} duplicate record(s) of secUid=${secUid} into ${primary.id}`,
    );
    return primary.id;
  }

  private async saveProfile(accountId: string, profile: ScrapedProfile): Promise<void> {
    const now = new Date();

    // 先做 dedup：返回最终要写入的目标 id（可能跟入参不同）
    const targetId = await this.dedupBySecUid(accountId, profile.secUid);

    for (const v of profile.videos) {
      const upserted = await this.prisma.tiktokVideo.upsert({
        where: { accountId_videoId: { accountId: targetId, videoId: v.videoId } },
        create: {
          accountId: targetId,
          videoId: v.videoId,
          title: v.title,
          coverUrl: v.coverUrl,
          videoUrl: v.videoUrl,
          durationMs: v.durationMs,
          publishedAt: v.publishedAt,
          playCount: BigInt(v.playCount),
          likeCount: BigInt(v.likeCount),
          commentCount: BigInt(v.commentCount),
          shareCount: BigInt(v.shareCount),
          collectCount: BigInt(v.collectCount),
          scrapedAt: now,
        },
        update: {
          title: v.title,
          coverUrl: v.coverUrl,
          videoUrl: v.videoUrl,
          durationMs: v.durationMs,
          publishedAt: v.publishedAt,
          playCount: BigInt(v.playCount),
          likeCount: BigInt(v.likeCount),
          commentCount: BigInt(v.commentCount),
          shareCount: BigInt(v.shareCount),
          collectCount: BigInt(v.collectCount),
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
        },
      });
    }

    // 状态判定：videos=0 但 stats.videoCount>0 → rate_limited（TikTok 反爬）
    const status =
      profile.videos.length === 0 && profile.videoCount > 0 ? "rate_limited" : "active";
    const errorMsg =
      status === "rate_limited"
        ? `账号声明有 ${profile.videoCount} 个视频，但 TikTok 视频列表 API 暂时未返回数据，请稍后重试`
        : null;

    // 同一 TikTok 用户可能被以 handle / UID 两种方式分别创建为两条记录。
    // 抓取后想给"另一种"字段回填值，但目标值可能已被另一条记录占用 → unique 冲突。
    // 策略：只在该值未被他人占用时才写入；占用了就保持当前 null。
    const handleToSet = profile.uniqueId ? `@${profile.uniqueId}` : null;
    const uidToSet = profile.uid || null;

    let safeHandle: string | undefined = handleToSet ?? undefined;
    let safeUid: string | undefined = uidToSet ?? undefined;

    if (handleToSet) {
      const handleConflict = await this.prisma.tiktokAccount.findFirst({
        where: { handle: handleToSet, NOT: { id: targetId } },
        select: { id: true },
      });
      if (handleConflict) {
        this.logger.warn(
          `Handle ${handleToSet} already taken by ${handleConflict.id}, skipping handle write for ${targetId}`,
        );
        safeHandle = undefined;
      }
    }
    if (uidToSet) {
      const uidConflict = await this.prisma.tiktokAccount.findFirst({
        where: { uid: uidToSet, NOT: { id: targetId } },
        select: { id: true },
      });
      if (uidConflict) {
        this.logger.warn(
          `UID ${uidToSet} already taken by ${uidConflict.id}, skipping uid write for ${targetId}`,
        );
        safeUid = undefined;
      }
    }

    await this.prisma.tiktokAccount.update({
      where: { id: targetId },
      data: {
        ...(safeUid !== undefined ? { uid: safeUid } : {}),
        ...(safeHandle !== undefined ? { handle: safeHandle } : {}),
        secUid: profile.secUid || undefined,
        nickname: profile.nickname || undefined,
        avatarUrl: profile.avatarUrl || undefined,
        bioSignature: profile.bioSignature || undefined,
        followerCount: profile.followerCount,
        followingCount: profile.followingCount,
        heartCount: profile.heartCount,
        videoCount: profile.videoCount,
        lastScrapedAt: now,
        status,
        lastErrorMessage: errorMsg,
        lastErrorAt: errorMsg ? now : null,
      },
    });
  }

  private async markStatus(
    accountId: string,
    status: "not_found" | "rate_limited" | "error",
    message: string,
  ): Promise<void> {
    await this.prisma.tiktokAccount.update({
      where: { id: accountId },
      data: { status, lastErrorMessage: message, lastErrorAt: new Date() },
    });
  }
}
