import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaService } from "./prisma.service";
import { EnvService } from "./env.service";

/**
 * 定时扫描所有活跃账号，按 scrapeIntervalMin 间隔自动入队抓取任务。
 * 使用递归 setTimeout + jitter 避免 thundering herd。
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly queue: Queue;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {
    this.queue = new Queue("tt-scrape", { connection: this.env.redisConnection });
  }

  async onModuleInit() {
    this.logger.log("Scheduler started");
    this.running = true;
    this.scheduleNext();
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.queue.close();
    this.logger.log("Scheduler stopped");
  }

  private scheduleNext(): void {
    if (!this.running) return;
    // 基础间隔 60s ± 10s jitter，避免所有实例同时扫描
    const jitter = Math.random() * 20_000 - 10_000;
    const delay = 60_000 + jitter;
    this.timer = setTimeout(() => {
      this.tick().catch(() => undefined).finally(() => this.scheduleNext());
    }, Math.max(5_000, delay));
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const accounts = await this.prisma.tiktokAccount.findMany({
      where: {
        status: { in: ["active", "error"] },
        OR: [
          { lastScrapedAt: null },
          {
            lastScrapedAt: {
              lte: new Date(now.getTime() - 60 * 60 * 1000),
            },
          },
        ],
      },
      select: { id: true, handle: true, scrapeIntervalMin: true, lastScrapedAt: true },
    });

    for (const acc of accounts) {
      const last = acc.lastScrapedAt?.getTime() ?? 0;
      const intervalMs = Math.max(acc.scrapeIntervalMin, 15) * 60 * 1000;
      if (now.getTime() - last >= intervalMs) {
        try {
          // 每个账号再额外加 0-5s jitter，避免同时入队
          const jobJitter = Math.floor(Math.random() * 5_000);
          await new Promise((r) => setTimeout(r, jobJitter));

          await this.queue.add(
            "scrape",
            { accountId: acc.id, triggeredBy: "scheduler", manual: false },
            {
              jobId: `scheduled:${acc.id}:${Math.floor(now.getTime() / 1000)}`,
              removeOnComplete: 50,
              removeOnFail: 50,
            },
          );
          this.logger.log(`Enqueued scheduled scrape for ${acc.handle}`);
        } catch (e) {
          this.logger.error(`Failed to enqueue ${acc.handle}: ${(e as Error).message}`);
        }
      }
    }
  }
}
