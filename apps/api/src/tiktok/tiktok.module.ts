import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../prisma/prisma.module";
import { TiktokController } from "./tiktok.controller";
import { TiktokHealthController } from "./health.controller";
import { TiktokService, TIKTOK_QUEUE_NAME } from "./tiktok.service";

@Module({
  imports: [PrismaModule, BullModule.registerQueue({ name: TIKTOK_QUEUE_NAME })],
  controllers: [TiktokController, TiktokHealthController],
  providers: [TiktokService],
  exports: [TiktokService],
})
export class TiktokModule {}
