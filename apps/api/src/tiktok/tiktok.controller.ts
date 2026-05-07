import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";
import { TiktokService } from "./tiktok.service";
import { CreateTiktokAccountDto } from "./dto/create-account.dto";
import { UpdateTiktokAccountDto } from "./dto/update-account.dto";
import { ListAccountsQueryDto } from "./dto/list-accounts.dto";

@Controller("tiktok")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin", "salesperson")
export class TiktokController {
  constructor(private readonly service: TiktokService) {}

  @Get("accounts")
  listAccounts(@CurrentUser() user: JwtUser, @Query() query: ListAccountsQueryDto) {
    return this.service.listAccounts(user, query);
  }

  @Post("accounts")
  createAccount(@CurrentUser() user: JwtUser, @Body() dto: CreateTiktokAccountDto) {
    return this.service.createAccount(user, dto);
  }

  @Get("accounts/:id")
  getAccount(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.service.getAccount(user, id);
  }

  @Patch("accounts/:id")
  updateAccount(
    @CurrentUser() user: JwtUser,
    @Param("id") id: string,
    @Body() dto: UpdateTiktokAccountDto,
  ) {
    return this.service.updateAccount(user, id, dto);
  }

  @Delete("accounts/:id")
  deleteAccount(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.service.deleteAccount(user, id);
  }

  @Post("accounts/:id/refresh")
  refreshAccount(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.service.refreshAccount(user, id);
  }

  @Get("accounts/:id/videos")
  listVideos(
    @CurrentUser() user: JwtUser,
    @Param("id") id: string,
    @Query("sortBy") sortBy?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.listVideos(user, id, {
      sortBy,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get("accounts/:id/stats")
  getRecentStats(
    @CurrentUser() user: JwtUser,
    @Param("id") id: string,
    @Query("days") days?: string,
  ) {
    return this.service.getRecentStats(user, id, days ? Number(days) : 15);
  }
}
