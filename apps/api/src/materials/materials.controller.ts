import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";
import { MaterialsService } from "./materials.service";

@Controller("materials")
@UseGuards(JwtAuthGuard)
export class MaterialsController {
  constructor(private readonly materialsService: MaterialsService) {}

  @Get()
  async list(
    @CurrentUser() user: JwtUser,
    @Query("mediaType") mediaType?: string,
    @Query("source") source?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.materialsService.list(user.sub, {
      mediaType,
      source,
      cursor,
      limit: limit ? Number(limit) : 20,
    });
  }

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async upload(
    @CurrentUser() user: JwtUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException("file is required");

    const mediaType = file.mimetype.startsWith("video/") ? "video" : "image";

    return this.materialsService.upload({
      userId: user.sub,
      name: Buffer.from(file.originalname, "latin1").toString("utf8"),
      buffer: file.buffer,
      mimeType: file.mimetype,
      mediaType: mediaType as any,
      source: "uploaded",
    });
  }

  @Post(":id/archive")
  async archive(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.materialsService.archive(user.sub, id);
  }

  @Delete(":id")
  async remove(@CurrentUser() user: JwtUser, @Param("id") id: string) {
    return this.materialsService.remove(user.sub, id);
  }
}
