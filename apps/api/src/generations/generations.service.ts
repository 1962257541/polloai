import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  GenerationType,
  TaskStatus,
  imageToVideoSchema,
  textToImageSchema,
} from "@packages/shared";
import { ZodError } from "zod";
import { CreateImageDto } from "./dto/create-image.dto";
import { CreateVideoFromImageDto } from "./dto/create-video-from-image.dto";
import { GENERATION_QUEUE } from "./constants";

@Injectable()
export class GenerationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly notificationsService: NotificationsService,
    @InjectQueue(GENERATION_QUEUE) private readonly queue: Queue,
  ) {}

  async createImageTask(
    userId: string,
    payload: CreateImageDto,
    file?: Express.Multer.File,
  ) {
    let referenceImage:
      | {
          key: string;
          url: string;
          sizeBytes: number;
          mimeType: string;
        }
      | undefined;

    if (file) {
      const uploaded = await this.storageService.uploadBuffer(file.buffer, {
        prefix: "inputs/images",
        extension: this.extensionFromMime(file.mimetype),
        contentType: file.mimetype,
      });
      referenceImage = {
        ...uploaded,
        mimeType: file.mimetype,
      };
    }

    let parsed: ReturnType<typeof textToImageSchema.parse>;
    try {
      parsed = textToImageSchema.parse({
        ...payload,
        referenceImageUrl: referenceImage?.url,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(error.flatten());
      }
      throw error;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { apiKey: true, apiUrl: true, imageModel: true, imageModels: true },
    });

    if (!user?.apiKey || !user?.apiUrl) {
      throw new BadRequestException("API Key 和 API URL 未配置，请先到账号设置中配置。");
    }

    const availableModels = this.normalizeConfiguredModels(user.imageModels, user.imageModel);
    if (parsed.model && !availableModels.includes(parsed.model)) {
      throw new BadRequestException("Selected image model is not enabled for this account");
    }

    const imageModel = parsed.model || availableModels[0];
    if (!imageModel) {
      throw new BadRequestException("No image models are configured for this account");
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.generationTask.create({
        data: {
          userId,
          type: "text_to_image",
          status: "queued",
          provider: "gemini",
          model: imageModel,
          prompt: parsed.prompt,
          negativePrompt: parsed.negativePrompt,
          parameters: parsed,
        },
      });

      if (referenceImage) {
        await tx.generationAsset.create({
          data: {
            taskId: created.id,
            role: "input",
            mediaType: "image",
            url: referenceImage.url,
            storageKey: referenceImage.key,
            mimeType: referenceImage.mimeType,
            sizeBytes: referenceImage.sizeBytes,
          },
        });
      }

      return created;
    });

    await this.enqueueTaskOrFail(
      task.id,
      user.apiKey,
      user.apiUrl ?? undefined,
      parsed.imageApiType ?? "gemini-native",
    );

    await this.notificationsService.publish({
      taskId: task.id,
      userId,
      status: "queued",
      type: "text_to_image",
    });

    return { taskId: task.id, status: task.status };
  }

  async createVideoFromImageTask(
    userId: string,
    payload: CreateVideoFromImageDto,
    file?: Express.Multer.File,
  ) {
    let imageUrl = payload.imageUrl;

    if (file) {
      const uploaded = await this.storageService.uploadBuffer(file.buffer, {
        prefix: "inputs/images",
        extension: this.extensionFromMime(file.mimetype),
        contentType: file.mimetype,
      });
      imageUrl = uploaded.url;
    }

    let parsed: ReturnType<typeof imageToVideoSchema.parse>;
    try {
      parsed = imageToVideoSchema.parse({ ...payload, imageUrl });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(error.flatten());
      }
      throw error;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { apiKey: true, apiUrl: true, videoModel: true, videoModels: true },
    });

    if (!user?.apiKey || !user?.apiUrl) {
      throw new BadRequestException("API Key 和 API URL 未配置，请先到账号设置中配置。");
    }

    const availableModels = this.normalizeConfiguredModels(user.videoModels, user.videoModel);
    if (parsed.model && !availableModels.includes(parsed.model)) {
      throw new BadRequestException("Selected video model is not enabled for this account");
    }

    const videoModel = parsed.model || availableModels[0];
    if (!videoModel) {
      throw new BadRequestException("No video models are configured for this account");
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.generationTask.create({
        data: {
          userId,
          type: "image_to_video",
          status: "queued",
          provider: "gemini",
          model: videoModel,
          prompt: parsed.prompt,
          negativePrompt: parsed.negativePrompt,
          parameters: parsed,
        },
      });

      await tx.generationAsset.create({
        data: {
          taskId: created.id,
          role: "input",
          mediaType: "image",
          url: parsed.imageUrl!,
          storageKey: parsed.imageUrl!,
          mimeType: file?.mimetype,
          sizeBytes: file?.size,
        },
      });

      return created;
    });

    await this.enqueueTaskOrFail(task.id, user.apiKey, user.apiUrl ?? undefined);

    await this.notificationsService.publish({
      taskId: task.id,
      userId,
      status: "queued",
      type: "image_to_video",
    });

    return { taskId: task.id, status: task.status };
  }

  async getTask(userId: string, taskId: string) {
    const task = await this.prisma.generationTask.findFirst({
      where: { id: taskId, userId },
      include: { assets: true },
    });

    if (!task) {
      throw new NotFoundException("Task not found");
    }

    return task;
  }

  async listTasks(
    userId: string,
    input: { status?: string; type?: string; limit: number; offset: number },
  ) {
    const where = {
      userId,
      ...(input.status ? { status: input.status as TaskStatus } : {}),
      ...(input.type ? { type: input.type as GenerationType } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.generationTask.findMany({
        where,
        include: { assets: true },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit, 1), 100),
        skip: Math.max(input.offset, 0),
      }),
      this.prisma.generationTask.count({ where }),
    ]);

    return { items, total };
  }

  async cancelTask(userId: string, taskId: string) {
    const task = await this.prisma.generationTask.findFirst({
      where: { id: taskId, userId },
    });

    if (!task) {
      throw new NotFoundException("Task not found");
    }

    if (["succeeded", "failed", "cancelled"].includes(task.status)) {
      return { taskId, status: task.status };
    }

    await this.prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        errorCode: "TASK_CANCELLED",
        errorMessage: "Cancelled by user",
      },
    });

    const job = await this.queue.getJob(taskId);
    if (job) {
      await job.remove();
    }

    await this.notificationsService.publish({
      taskId,
      userId,
      status: "cancelled",
      type: task.type as GenerationType,
      errorMessage: "Cancelled by user",
    });

    return { taskId, status: "cancelled" };
  }

  async deleteTask(userId: string, taskId: string) {
    const task = await this.prisma.generationTask.findFirst({
      where: { id: taskId, userId },
    });

    if (!task) {
      throw new NotFoundException("Task not found");
    }

    if (task.status === "queued" || task.status === "running") {
      const job = await this.queue.getJob(taskId);
      if (job) await job.remove();
    }

    await this.prisma.generationTask.delete({ where: { id: taskId } });
    return { success: true };
  }

  private async enqueueTaskOrFail(taskId: string, apiKey: string, apiUrl?: string, imageApiType?: string) {
    try {
      await this.queue.add(
        "process-generation",
        { taskId, apiKey, apiUrl, imageApiType },
        {
          jobId: taskId,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 2000,
          },
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      );
    } catch (error) {
      await this.markFailed(taskId, "QUEUE_ENQUEUE_FAILED", String(error));
      throw new InternalServerErrorException("Failed to enqueue generation task");
    }
  }

  private async markFailed(taskId: string, errorCode: string, errorMessage: string) {
    const task = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
    if (!task) return;
    if (["failed", "cancelled", "succeeded"].includes(task.status)) return;

    await this.prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: "failed",
        errorCode,
        errorMessage,
        finishedAt: new Date(),
      },
    });

    await this.notificationsService.publish({
      taskId: task.id,
      userId: task.userId,
      status: "failed",
      type: task.type as GenerationType,
      errorMessage,
    });
  }

  private extensionFromMime(mime: string) {
    if (mime.includes("png")) return "png";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    return "bin";
  }

  private normalizeConfiguredModels(models: string[] | null | undefined, fallback?: string | null) {
    return Array.from(
      new Set([...(models ?? []), ...(fallback ? [fallback] : [])].map((model) => model.trim()).filter(Boolean)),
    );
  }
}
