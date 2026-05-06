import { Module } from "@nestjs/common";
import { EnvService } from "./services/env.service";
import { PrismaService } from "./services/prisma.service";
import { HeartbeatService } from "./services/heartbeat.service";
import { SystemConfigLoaderService } from "./services/system-config-loader.service";
import { BrowserPoolService } from "./services/browser-pool.service";
import { AffiliateScraperService } from "./services/affiliate-scraper.service";
import { MonitorWorkerService } from "./services/monitor-worker.service";
import { SchedulerService } from "./services/scheduler.service";

@Module({
  providers: [
    EnvService,
    PrismaService,
    SystemConfigLoaderService,
    HeartbeatService,
    BrowserPoolService,
    AffiliateScraperService,
    MonitorWorkerService,
    SchedulerService,
  ],
})
export class ScraperModule {}
