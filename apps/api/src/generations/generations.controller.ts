import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Body,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";
import { CreateImageDto } from "./dto/create-image.dto";
import { CreateVideoFromImageDto } from "./dto/create-video-from-image.dto";
import { GenerationsService } from "./generations.service";

@Controller("generations")
@UseGuards(JwtAuthGuard)
export class GenerationsController {
  constructor(private readonly generationsService: GenerationsService) {}

  @Post("image")
  async createImage(@CurrentUser() user: JwtUser, @Body() body: CreateImageDto) {
    return this.generationsService.createImageTask(user.sub, body);
  }

  @Post("video-from-image")
  @UseInterceptors(
    FileInterceptor("image", {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async createVideoFromImage(
    @CurrentUser() user: JwtUser,
    @Body() body: CreateVideoFromImageDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!body.imageUrl && !file) {
      throw new BadRequestException("imageUrl or image file is required");
    }
    return this.generationsService.createVideoFromImageTask(user.sub, body, file);
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
    @Query("limit") limit = "20",
    @Query("offset") offset = "0",
  ) {
    return this.generationsService.listTasks(user.sub, {
      status,
      type,
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
}
