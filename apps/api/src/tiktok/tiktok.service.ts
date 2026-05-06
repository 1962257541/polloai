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
import { SystemConfigService } from "../system-config/system-config.service";
import { SystemConfigCryptoService } from "../system-config/crypto.service";
import { JwtUser } from "../common/current-user.decorator";
import { CreateTiktokAccountDto } from "./dto/create-account.dto";
import { UpdateTiktokAccountDto } from "./dto/update-account.dto";
import { ListAccountsQueryDto } from "./dto/list-accounts.dto";

export const TIKTOK_QUEUE_NAME = "tt-scrape";

interface AccountSummary {
  id: string;
  ownerId: string;
  handle: string;
  nickname: string | null;
  status: TiktokAccountStatus;
  lastScrapedAt: Date | null;
  followerCount: number;
  videoCount: number;
  totalGmvCents: string;
  totalCommissionCents: string;
  totalOrders: number;
  lastErrorMessage: string | null;
}

interface AccountDetail extends AccountSummary {
  scrapeIntervalMin: number;
  hasStorageState: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class TiktokService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly crypto: SystemConfigCryptoService,
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
        { nickname: { contains: text, mode: "insensitive" } },
      ];
    }

    // 行级权限：salesperson 强制看自己；admin 默认仅自己（mine），可 scope=all 看全部
    if (user.role !== "admin") {
      where.ownerId = user.sub;
    } else if ((q.scope ?? "mine") === "mine") {
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
    const handle = dto.handle.startsWith("@") ? dto.handle : `@${dto.handle}`;

    const exists = await this.prisma.tiktokAccount.findUnique({ where: { handle } });
    if (exists) {
      throw new BadRequestException(`账号 ${handle} 已存在`);
    }

    const created = await this.prisma.tiktokAccount.create({
      data: {
        ownerId: user.sub,
        handle,
        nickname: dto.nickname ?? null,
        scrapeIntervalMin: dto.scrapeIntervalMin ?? 60,
      },
    });
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
        ...(dto.nickname !== undefined ? { nickname: dto.nickname } : {}),
        ...(dto.scrapeIntervalMin !== undefined
          ? { scrapeIntervalMin: dto.scrapeIntervalMin }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });
    return this.toDetail(updated);
  }

  async deleteAccount(user: JwtUser, id: string): Promise<void> {
    await this.ensureAccessible(user, id);
    await this.prisma.tiktokAccount.delete({ where: { id } });
  }

  // ============ Cookie 上传 ============

  async uploadCookie(user: JwtUser, id: string, buffer: Buffer): Promise<{ ok: true }> {
    await this.ensureAccessible(user, id);

    if (!buffer || buffer.length === 0) {
      throw new BadRequestException("文件为空");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new BadRequestException("无法解析 JSON，期望 Playwright storage_state 格式");
    }

    const cookieKey = await this.systemConfig.getCookieKeyBuffer();
    if (!cookieKey) {
      throw new BadRequestException("Cookie 主密钥尚未配置，请联系管理员先生成");
    }

    const blob = this.crypto.encryptWithKey(cookieKey, parsed);
    await this.prisma.tiktokAccount.update({
      where: { id },
      data: {
        storageStateEnc: new Uint8Array(blob.enc),
        storageStateIv: new Uint8Array(blob.iv),
        storageStateTag: new Uint8Array(blob.tag),
        status: "active",
        lastErrorMessage: null,
        lastErrorAt: null,
      },
    });

    return { ok: true };
  }

  // ============ 触发刷新 ============

  async refreshAccount(user: JwtUser, id: string): Promise<{ enqueued: true }> {
    await this.ensureAccessible(user, id);
    await this.queue.add(
      "scrape",
      { accountId: id, triggeredBy: user.sub, manual: true },
      {
        jobId: `manual:${id}:${Date.now()}`,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return { enqueued: true };
  }

  // ============ 视频列表 / 趋势 ============

  async listVideos(
    user: JwtUser,
    accountId: string,
    sortBy?: string,
  ): Promise<Array<ReturnType<TiktokService["toVideo"]>>> {
    await this.ensureAccessible(user, accountId);

    const orderBy: Prisma.TiktokVideoOrderByWithRelationInput =
      sortBy === "playCount"
        ? { playCount: "desc" }
        : sortBy === "gmv"
          ? { gmvCents: "desc" }
          : sortBy === "orderCount"
            ? { orderCount: "desc" }
            : { publishedAt: "desc" };

    const videos = await this.prisma.tiktokVideo.findMany({
      where: { accountId },
      orderBy,
    });
    return videos.map((v) => this.toVideo(v));
  }

  async listVideoMetrics(
    user: JwtUser,
    accountId: string,
    videoId: string,
    days = 7,
  ): Promise<Array<{ capturedAt: Date; playCount: string; likeCount: string; gmvCents: string }>> {
    await this.ensureAccessible(user, accountId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const metrics = await this.prisma.tiktokVideoMetric.findMany({
      where: {
        videoId,
        capturedAt: { gte: since },
        video: { accountId },
      },
      orderBy: { capturedAt: "asc" },
    });
    return metrics.map((m) => ({
      capturedAt: m.capturedAt,
      playCount: m.playCount.toString(),
      likeCount: m.likeCount.toString(),
      gmvCents: m.gmvCents.toString(),
    }));
  }

  // ============ 内部 ============

  private async ensureAccessible(user: JwtUser, id: string): Promise<TiktokAccount> {
    const acc = await this.prisma.tiktokAccount.findUnique({ where: { id } });
    if (!acc) {
      throw new NotFoundException("账号不存在");
    }
    if (user.role !== "admin" && acc.ownerId !== user.sub) {
      throw new ForbiddenException("无权访问该账号");
    }
    return acc;
  }

  private toSummary(a: TiktokAccount): AccountSummary {
    return {
      id: a.id,
      ownerId: a.ownerId,
      handle: a.handle,
      nickname: a.nickname,
      status: a.status,
      lastScrapedAt: a.lastScrapedAt,
      followerCount: a.followerCount,
      videoCount: a.videoCount,
      totalGmvCents: a.totalGmvCents.toString(),
      totalCommissionCents: a.totalCommissionCents.toString(),
      totalOrders: a.totalOrders,
      lastErrorMessage: a.lastErrorMessage,
    };
  }

  private toDetail(a: TiktokAccount): AccountDetail {
    return {
      ...this.toSummary(a),
      scrapeIntervalMin: a.scrapeIntervalMin,
      hasStorageState: a.storageStateEnc != null,
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
    publishedAt: Date | null;
    playCount: bigint;
    likeCount: bigint;
    commentCount: bigint;
    shareCount: bigint;
    collectCount: bigint;
    gmvCents: bigint;
    orderCount: number;
    scrapedAt: Date;
  }) {
    return {
      id: v.id,
      videoId: v.videoId,
      title: v.title,
      coverUrl: v.coverUrl,
      publishedAt: v.publishedAt,
      playCount: v.playCount.toString(),
      likeCount: v.likeCount.toString(),
      commentCount: v.commentCount.toString(),
      shareCount: v.shareCount.toString(),
      collectCount: v.collectCount.toString(),
      gmvCents: v.gmvCents.toString(),
      orderCount: v.orderCount,
      scrapedAt: v.scrapedAt,
    };
  }
}
