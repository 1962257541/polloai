import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";
import { SystemConfigService } from "./system-config.service";
import { UpdateTiktokConfigDto } from "./dto/update-tiktok-config.dto";

@Controller("admin/system-config")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SystemConfigController {
  constructor(private readonly service: SystemConfigService) {}

  @Get("tiktok")
  @Roles("admin")
  getTiktok() {
    return this.service.getTiktokConfig();
  }

  @Put("tiktok")
  @Roles("admin")
  updateTiktok(
    @Body() body: UpdateTiktokConfigDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.updateTiktokConfig(body, user.sub);
  }

  @Post("tiktok/cookie-key/rotate")
  @Roles("admin")
  @HttpCode(200)
  rotateCookieKey(@CurrentUser() user: JwtUser) {
    return this.service.rotateTiktokCookieKey(user.sub);
  }

  @Delete("tiktok/cookie-key")
  @Roles("admin")
  @HttpCode(204)
  async resetCookieKey(@CurrentUser() user: JwtUser): Promise<void> {
    await this.service.resetTiktokCookieKey(user.sub);
  }
}
