import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
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

  @Post("accounts/:id/cookies")
  @UseInterceptors(FileInterceptor("file"))
  uploadCookie(
    @CurrentUser() user: JwtUser,
    @Param("id") id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.uploadCookie(user, id, file?.buffer ?? Buffer.alloc(0));
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
  ) {
    return this.service.listVideos(user, id, sortBy);
  }

  @Get("accounts/:id/videos/:videoId/metrics")
  listVideoMetrics(
    @CurrentUser() user: JwtUser,
    @Param("id") id: string,
    @Param("videoId") videoId: string,
    @Query("days") days?: string,
  ) {
    return this.service.listVideoMetrics(user, id, videoId, days ? Number(days) : 7);
  }
}
