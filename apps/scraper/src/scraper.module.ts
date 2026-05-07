import { Module } from "@nestjs/common";
import { EnvService } from "./services/env.service";
import { PrismaService } from "./services/prisma.service";
import { HeartbeatService } from "./services/heartbeat.service";
import { BrowserPoolService } from "./services/browser-pool.service";
import { PublicProfileScraperService } from "./services/public-profile-scraper.service";
import { MonitorWorkerService } from "./services/monitor-worker.service";

@Module({
  providers: [
    EnvService,
    PrismaService,
    HeartbeatService,
    BrowserPoolService,
    PublicProfileScraperService,
    MonitorWorkerService,
  ],
})
export class ScraperModule {}
