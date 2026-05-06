import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigController } from "./system-config.controller";
import { SystemConfigService } from "./system-config.service";
import { SystemConfigCryptoService } from "./crypto.service";

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [SystemConfigController],
  providers: [SystemConfigService, SystemConfigCryptoService],
  exports: [SystemConfigService, SystemConfigCryptoService],
})
export class SystemConfigModule {}
