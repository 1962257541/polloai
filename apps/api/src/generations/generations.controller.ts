import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";
import { CreateImageDto } from "./dto/create-image.dto";
import { CreateVideoFromImageDto } from "./dto/create-video-from-image.dto";
import { CreateVideoUpscaleDto } from "./dto/create-video-upscale.dto";
import { GenerationsService } from "./generations.service";

@Controller("generations")
@UseGuards(JwtAuthGuard)
export class GenerationsController {
  constructor(private readonly generationsService: GenerationsService) {}

  @Post("image")
  @UseInterceptors(
    FilesInterceptor("referenceImages", 9, {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async createImage(
    @CurrentUser() user: JwtUser,
    @Body() body: CreateImageDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.generationsService.createImageTask(user.sub, body, files ?? []);
  }

  @Post("video-from-image")
  @UseInterceptors(
    FilesInterceptor("images", 9, {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async createVideoFromImage(
    @CurrentUser() user: JwtUser,
    @Body() body: CreateVideoFromImageDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const hasUrl = Boolean(body.imageUrl) || (Array.isArray(body.imageUrls) ? body.imageUrls.length > 0 : Boolean(body.imageUrls));
    if (!hasUrl && (!files || files.length === 0)) {
      throw new BadRequestException("imageUrl/imageUrls or image files are required");
    }
    return this.generationsService.createVideoFromImageTask(user.sub, body, files ?? []);
  }

  @Post("video-upscale")
  async createVideoUpscale(
    @CurrentUser() user: JwtUser,
    @Body() body: CreateVideoUpscaleDto,
  ) {
    return this.generationsService.createVideoUpscaleTask(user.sub, body);
  }

  @Get("sessions")
  async listSessions(
    @CurrentUser() user: JwtUser,
    @Query("type") type?: string,
    @Query("limit") limit = "20",
    @Query("offset") offset = "0",
  ) {
    return this.generationsService.listSessions(user.sub, {
      type,
      limit: Number(limit),
      offset: Number(offset),
    });
  }

  @Patch("sessions/:sessionId/title")
  async renameSession(
    @CurrentUser() user: JwtUser,
    @Param("sessionId") sessionId: string,
    @Body("title") title: string,
  ) {
    return this.generationsService.renameSession(user.sub, sessionId, title);
  }

  @Get(":taskId")
  async getTask(@CurrentUser() user: JwtUser, @Param("taskId") taskId: string) {
    return this.generationsService.getTask(user.sub, taskId);
  }

  @Get()
  async listTasks(
    @CurrentUser() user: JwtUser,
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("sessionId") sessionId?: string,
    @Query("limit") limit = "20",
    @Query("offset") offset = "0",
  ) {
    return this.generationsService.listTasks(user.sub, {
      status,
      type,
      sessionId,
      limit: Number(limit),
      offset: Number(offset),
    });
  }

  @Post(":taskId/cancel")
  async cancelTask(@CurrentUser() user: JwtUser, @Param("taskId") taskId: string) {
    return this.generationsService.cancelTask(user.sub, taskId);
  }

  @Delete(":taskId")
  async deleteTask(@CurrentUser() user: JwtUser, @Param("taskId") taskId: string) {
    return this.generationsService.deleteTask(user.sub, taskId);
  }

  @Delete()
  async deleteAllTasks(
    @CurrentUser() user: JwtUser,
    @Query("type") type?: string,
    @Query("onlyTerminated") onlyTerminated?: string,
  ) {
    return this.generationsService.deleteAllTasks(user.sub, { type, onlyTerminated: onlyTerminated === "true" });
  }
}
