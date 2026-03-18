import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { GenerationsService } from "./generations.service";
import { GenerationsController } from "./generations.controller";
import { GENERATION_QUEUE } from "./constants";
import { StorageModule } from "../storage/storage.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: GENERATION_QUEUE }),
    StorageModule,
    NotificationsModule,
  ],
  providers: [GenerationsService],
  controllers: [GenerationsController],
  exports: [GenerationsService],
})
export class GenerationsModule {}
