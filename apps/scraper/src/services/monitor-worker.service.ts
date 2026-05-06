import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, Job } from "bullmq";
import { AffiliateScraperService } from "./affiliate-scraper.service";
import { HeartbeatService } from "./heartbeat.service";
import { EnvService } from "./env.service";

interface ScrapeJob {
  accountId: string;
  triggeredBy?: string;
  manual?: boolean;
}

/**
 * BullMQ Worker：消费 tt-scrape 队列，执行实际抓取。
 */
@Injectable()
export class MonitorWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorWorkerService.name);
  private worker: Worker | null = null;

  constructor(
    private readonly scraper: AffiliateScraperService,
    private readonly heartbeat: HeartbeatService,
    private readonly env: EnvService,
  ) {}

  async onModuleInit() {
    this.worker = new Worker(
      "tt-scrape",
      async (job: Job<ScrapeJob>) => {
        const { accountId } = job.data;
        this.logger.log(`Processing job ${job.id} for account ${accountId}`);

        this.heartbeat.activeBrowsers = this.heartbeat.activeBrowsers + 1;
        try {
          await this.scraper.scrapeAccount(accountId);
          this.heartbeat.successScrapesLastHour++;
        } finally {
          this.heartbeat.activeBrowsers = Math.max(0, this.heartbeat.activeBrowsers - 1);
          this.heartbeat.totalScrapesLastHour++;
        }
      },
      { connection: this.env.redisConnection, concurrency: 1 },
    );

    this.worker.on("completed", (job) => {
      this.logger.log(`Job ${job.id} completed`);
    });
    this.worker.on("failed", (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });

    this.logger.log("MonitorWorker started (queue=tt-scrape)");
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
      this.logger.log("MonitorWorker stopped");
    }
  }
}
