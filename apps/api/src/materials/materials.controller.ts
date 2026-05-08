import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Response } from "express";
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

  @Get(":id/download")
  async download(
    @CurrentUser() user: JwtUser,
    @Param("id") id: string,
    @Query("fakeIphone") fakeIphone: string | undefined,
    @Res() res: Response,
  ) {
    const wantFake = fakeIphone !== "0" && fakeIphone !== "false";
    const material = await this.materialsService.findOwned(user.sub, id);

    const setAttachmentHeaders = (filename: string, mime: string) => {
      // 第一段 filename= 必须为 ASCII（HTTP 头不允许非 ASCII），非 ASCII 字符替换为下划线作为兜底；
      // filename*= 段按 RFC 5987 用 UTF-8 编码承载真实文件名。
      // 注意：用 inline 而非 attachment —— Chrome 跨源 fetch 一个 attachment 响应会把它移交给下载子系统，
      // 导致 fetch().blob() 失败。前端拿到 blob 后自己用 a[download] 触发下载。
      const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
      const encoded = encodeURIComponent(filename);
      res.setHeader("Content-Type", mime);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
      );
      res.setHeader("Cache-Control", "private, no-store");
    };

    const writeBuffer = (buffer: Buffer, filename: string, mime: string) => {
      setAttachmentHeaders(filename, mime);
      // 强制关闭连接：避免某些场景 keep-alive socket 复用导致 body 被截断
      res.setHeader("Connection", "close");
      // 让 Node 自己根据 buffer 长度设 Content-Length，杜绝手动设置与实际写入字节不一致
      res.end(buffer);
    };

    // 视频 + 开启 iPhone 伪装：注入元数据后流式写出
    if (wantFake && material.mediaType === "video") {
      const result = await this.materialsService.buildIphoneVideo(user.sub, id);
      if (result) {
        writeBuffer(result.buffer, result.filename, "video/quicktime");
        return;
      }
      // 处理失败 → 落到下面的裸代理路径
    }

    // 统一裸代理：从 S3 取原始字节后透传，避免浏览器跨源 fetch 重定向到 MinIO
    const buffer = await this.materialsService.getRawBuffer(material);
    writeBuffer(buffer, material.name, material.mimeType || "application/octet-stream");
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
