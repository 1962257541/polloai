import { Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { EnvService } from "../config/env.service";
import { MaterialSource, MediaType } from "@prisma/client";

export interface CreateMaterialInput {
  userId: string;
  name: string;
  buffer: Buffer;
  mimeType: string;
  mediaType?: MediaType;
  source: MaterialSource;
  taskId?: string;
  expiresAt?: Date | null;
}

@Injectable()
export class MaterialsService {
  private readonly s3Client: S3Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly env: EnvService,
  ) {
    this.s3Client = new S3Client({
      region: env.s3Region,
      endpoint: env.s3Endpoint,
      forcePathStyle: env.s3ForcePathStyle,
      credentials: {
        accessKeyId: env.s3AccessKey,
        secretAccessKey: env.s3SecretKey,
      },
    });
  }

  async upload(input: CreateMaterialInput) {
    const ext = input.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
    const prefix = input.mediaType === "video" ? "materials/videos" : "materials/images";
    const { key, url, sizeBytes } = await this.storage.uploadBuffer(input.buffer, {
      prefix,
      extension: ext,
      contentType: input.mimeType,
    });

    const expiresAt =
      input.expiresAt !== undefined
        ? input.expiresAt
        : new Date(Date.now() + 24 * 60 * 60 * 1000);

    const material = await this.prisma.material.create({
      data: {
        userId: input.userId,
        name: input.name,
        url,
        storageKey: key,
        mimeType: input.mimeType,
        sizeBytes,
        mediaType: input.mediaType ?? "image",
        source: input.source,
        taskId: input.taskId ?? null,
        expiresAt,
      },
    });

    return this.serializeMaterial(material);
  }


  async list(
    userId: string,
    opts: {
      mediaType?: string;
      source?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(opts.limit ?? 20, 100);
    const where: any = { userId };

    if (opts.mediaType === "image" || opts.mediaType === "video") {
      where.mediaType = opts.mediaType;
    }
    if (opts.source === "uploaded" || opts.source === "generated") {
      where.source = opts.source;
    }
    if (opts.cursor) {
      where.createdAt = { lt: new Date(opts.cursor) };
    }

    // 用不带 cursor 的 where 统计总数（total 不受分页影响）
    const whereForCount: any = { userId };
    if (opts.mediaType === "image" || opts.mediaType === "video") {
      whereForCount.mediaType = opts.mediaType;
    }
    if (opts.source === "uploaded" || opts.source === "generated") {
      whereForCount.source = opts.source;
    }

    const [items, total] = await Promise.all([
      this.prisma.material.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit + 1,
      }),
      this.prisma.material.count({ where: whereForCount }),
    ]);

    const hasMore = items.length > limit;
    const result = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? result[result.length - 1].createdAt.toISOString() : null;

    return { items: result.map((item) => this.serializeMaterial(item)), nextCursor, total };
  }

  async archive(userId: string, materialId: string) {
    const material = await this.prisma.material.findUnique({ where: { id: materialId } });
    if (!material) throw new NotFoundException("Material not found");
    if (material.userId !== userId) throw new ForbiddenException();

    return this.prisma.material.update({
      where: { id: materialId },
      data: { expiresAt: null },
    });
  }

  async remove(userId: string, materialId: string) {
    const material = await this.prisma.material.findUnique({ where: { id: materialId } });
    if (!material) throw new NotFoundException("Material not found");
    if (material.userId !== userId) throw new ForbiddenException();

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.env.s3Bucket,
        Key: material.storageKey,
      }),
    );

    await this.prisma.material.delete({ where: { id: materialId } });
    return { success: true };
  }

  // 内部调用：生成任务完成后自动入库（无需上传，直接写记录）
  async createFromTask(input: {
    userId: string;
    name: string;
    url: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    mediaType: MediaType;
    taskId: string;
  }) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const material = await this.prisma.material.create({
      data: {
        userId: input.userId,
        name: input.name,
        url: input.url,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        mediaType: input.mediaType,
        source: "generated",
        taskId: input.taskId,
        expiresAt,
      },
    });

    return this.serializeMaterial(material);
  }

  private serializeMaterial<T extends { url: string; storageKey: string | null }>(material: T): T {
    return {
      ...material,
      url: this.storage.resolvePublicUrl(material.url, material.storageKey),
    };
  }
}
