import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Prisma, TiktokAccount, TiktokAccountStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { JwtUser } from "../common/current-user.decorator";
import { CreateTiktokAccountDto } from "./dto/create-account.dto";
import { UpdateTiktokAccountDto } from "./dto/update-account.dto";
import { ListAccountsQueryDto } from "./dto/list-accounts.dto";

export const TIKTOK_QUEUE_NAME = "tt-scrape";

interface AccountSummary {
  id: string;
  ownerId: string;
  handle: string | null;
  uid: string | null;
  secUid: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  bioSignature: string | null;
  salesTag: string | null;
  category: string | null;
  region: string | null;
  note: string | null;
  status: TiktokAccountStatus;
  followerCount: number;
  followingCount: number;
  heartCount: string;
  videoCount: number;
  lastScrapedAt: Date | null;
  lastErrorMessage: string | null;
}

interface AccountDetail extends AccountSummary {
  createdAt: Date;
  updatedAt: Date;
}

interface RecentStats {
  /** 用作过去 N 天聚合 */
  days: number;
  videoCount: number;
  totalPlay: string;
  avgPlay: number;
  /** 总播放 / 粉丝（粉丝为 0 时返 0） */
  playFollowerRatio: number;
  /** 视频数 / 天数 */
  postsPerDay: number;
}

@Injectable()
export class TiktokService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TIKTOK_QUEUE_NAME) private readonly queue: Queue,
  ) {}

  // ============ 列表 / 单条 ============

  async listAccounts(
    user: JwtUser,
    q: ListAccountsQueryDto,
  ): Promise<{ items: AccountSummary[]; total: number; page: number; pageSize: number }> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;

    const where: Prisma.TiktokAccountWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.q) {
      const text = q.q.trim();
      where.OR = [
        { handle: { contains: text, mode: "insensitive" } },
        { uid: { contains: text } },
        { nickname: { contains: text, mode: "insensitive" } },
        { salesTag: { contains: text, mode: "insensitive" } },
      ];
    }

    if (user.role !== "admin") {
      where.ownerId = user.sub;
    } else if ((q.scope ?? "all") === "mine") {
      where.ownerId = user.sub;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.tiktokAccount.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tiktokAccount.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toSummary(r)),
      total,
      page,
      pageSize,
    };
  }

  async getAccount(user: JwtUser, id: string): Promise<AccountDetail> {
    const acc = await this.ensureAccessible(user, id);
    return this.toDetail(acc);
  }

  // ============ CRUD ============

  async createAccount(user: JwtUser, dto: CreateTiktokAccountDto): Promise<AccountDetail> {
    if (!dto.handle && !dto.uid) {
      throw new BadRequestException("handle 或 uid 至少填一个");
    }

    const handle = dto.handle ? this.normalizeHandle(dto.handle) : null;
    const uid = dto.uid ?? null;

    if (handle) {
      const exists = await this.prisma.tiktokAccount.findUnique({ where: { handle } });
      if (exists) throw new BadRequestException(`账号 ${handle} 已存在`);
    }
    if (uid) {
      const exists = await this.prisma.tiktokAccount.findUnique({ where: { uid } });
      if (exists) throw new BadRequestException(`UID ${uid} 已存在`);
    }

    const created = await this.prisma.tiktokAccount.create({
      data: {
        ownerId: user.sub,
        handle,
        uid,
        salesTag: dto.salesTag ?? null,
        category: dto.category ?? null,
        region: dto.region ?? null,
        note: dto.note ?? null,
      },
    });

    // 创建后立即入队抓一次（不阻塞 HTTP 响应）
    await this.enqueueScrape(created.id, user.sub, true);

    return this.toDetail(created);
  }

  async updateAccount(
    user: JwtUser,
    id: string,
    dto: UpdateTiktokAccountDto,
  ): Promise<AccountDetail> {
    await this.ensureAccessible(user, id);
    const updated = await this.prisma.tiktokAccount.update({
      where: { id },
      data: {
        ...(dto.salesTag !== undefined ? { salesTag: dto.salesTag } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.region !== undefined ? { region: dto.region } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });
    return this.toDetail(updated);
  }

  async deleteAccount(user: JwtUser, id: string): Promise<void> {
    await this.ensureAccessible(user, id);
    await this.prisma.tiktokAccount.delete({ where: { id } });
  }

  // ============ 触发刷新 ============

  async refreshAccount(user: JwtUser, id: string): Promise<{ enqueued: true }> {
    await this.ensureAccessible(user, id);
    await this.enqueueScrape(id, user.sub, true);
    return { enqueued: true };
  }

  // ============ 视频列表 ============

  async listVideos(
    user: JwtUser,
    accountId: string,
    opts: { sortBy?: string; limit?: number } = {},
  ) {
    await this.ensureAccessible(user, accountId);

    const orderBy: Prisma.TiktokVideoOrderByWithRelationInput =
      opts.sortBy === "playCount"
        ? { playCount: "desc" }
        : { publishedAt: "desc" };

    const videos = await this.prisma.tiktokVideo.findMany({
      where: { accountId },
      orderBy,
      take: opts.limit && opts.limit > 0 ? opts.limit : undefined,
    });
    return videos.map((v) => this.toVideo(v));
  }

  // ============ 过去 N 天聚合 ============

  async getRecentStats(user: JwtUser, accountId: string, days = 15): Promise<RecentStats> {
    const acc = await this.ensureAccessible(user, accountId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const videos = await this.prisma.tiktokVideo.findMany({
      where: { accountId, publishedAt: { gte: since } },
      select: { playCount: true },
    });

    const videoCount = videos.length;
    const totalPlay = videos.reduce((sum, v) => sum + v.playCount, 0n);
    const avgPlay = videoCount === 0 ? 0 : Number(totalPlay / BigInt(videoCount));
    const playFollowerRatio =
      acc.followerCount > 0 ? Number(totalPlay) / acc.followerCount : 0;
    const postsPerDay = videoCount / days;

    return {
      days,
      videoCount,
      totalPlay: totalPlay.toString(),
      avgPlay,
      playFollowerRatio: Number(playFollowerRatio.toFixed(2)),
      postsPerDay: Number(postsPerDay.toFixed(2)),
    };
  }

  // ============ 内部 ============

  private async enqueueScrape(
    accountId: string,
    triggeredBy: string,
    manual: boolean,
  ): Promise<void> {
    await this.queue.add(
      "scrape",
      { accountId, triggeredBy, manual },
      {
        jobId: `${manual ? "manual" : "auto"}:${accountId}:${Date.now()}`,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }

  private async ensureAccessible(user: JwtUser, id: string): Promise<TiktokAccount> {
    const acc = await this.prisma.tiktokAccount.findUnique({ where: { id } });
    if (!acc) throw new NotFoundException("账号不存在");
    if (user.role !== "admin" && acc.ownerId !== user.sub) {
      throw new ForbiddenException("无权访问该账号");
    }
    return acc;
  }

  private normalizeHandle(input: string): string {
    const trimmed = input.trim();
    return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  }

  private toSummary(a: TiktokAccount): AccountSummary {
    return {
      id: a.id,
      ownerId: a.ownerId,
      handle: a.handle,
      uid: a.uid,
      secUid: a.secUid,
      nickname: a.nickname,
      avatarUrl: a.avatarUrl,
      bioSignature: a.bioSignature,
      salesTag: a.salesTag,
      category: a.category,
      region: a.region,
      note: a.note,
      status: a.status,
      followerCount: a.followerCount,
      followingCount: a.followingCount,
      heartCount: a.heartCount.toString(),
      videoCount: a.videoCount,
      lastScrapedAt: a.lastScrapedAt,
      lastErrorMessage: a.lastErrorMessage,
    };
  }

  private toDetail(a: TiktokAccount): AccountDetail {
    return {
      ...this.toSummary(a),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  private toVideo(v: {
    id: string;
    accountId: string;
    videoId: string;
    title: string | null;
    coverUrl: string | null;
    videoUrl: string | null;
    durationMs: number;
    publishedAt: Date | null;
    playCount: bigint;
    likeCount: bigint;
    commentCount: bigint;
    shareCount: bigint;
    collectCount: bigint;
    scrapedAt: Date;
  }) {
    return {
      id: v.id,
      videoId: v.videoId,
      title: v.title,
      coverUrl: v.coverUrl,
      videoUrl: v.videoUrl,
      durationMs: v.durationMs,
      publishedAt: v.publishedAt,
      playCount: v.playCount.toString(),
      likeCount: v.likeCount.toString(),
      commentCount: v.commentCount.toString(),
      shareCount: v.shareCount.toString(),
      collectCount: v.collectCount.toString(),
      scrapedAt: v.scrapedAt,
    };
  }
}
