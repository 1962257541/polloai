import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { EnvModule } from "./config/env.module";
import { EnvService } from "./config/env.service";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AdminModule } from "./admin/admin.module";
import { GenerationsModule } from "./generations/generations.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { StorageModule } from "./storage/storage.module";
import { MaterialsModule } from "./materials/materials.module";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuditInterceptor } from "./audit/audit.interceptor";
import { AuditModule } from "./audit/audit.module";

@Module({
  imports: [
    EnvModule,
    BullModule.forRootAsync({
      imports: [EnvModule],
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        connection: env.redisConnection,
      }),
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    NotificationsModule,
    StorageModule,
    GenerationsModule,
    MaterialsModule,
    AuditModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
})
export class AppModule {}
