import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import Redis from "ioredis";
import { EnvService } from "./env.service";
import { PrismaService } from "./prisma.service";
import { StorageService } from "./storage.service";
import { GeminiService } from "./gemini.service";
import { GenerationType } from "@packages/shared";

const QUEUE_NAME = "generation-jobs";
const CHANNEL = "generation-status";

class TaskCancelledError extends Error {
  constructor() {
    super("Task cancelled");
  }
}

class RetryableGenerationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

@Injectable()
export class GenerationWorkerService implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly publisher: Redis;

  constructor(
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly gemini: GeminiService,
  ) {
    this.publisher = new Redis(env.redisUrl);
  }

  async onModuleInit() {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        await this.process(job);
      },
      {
        connection: this.env.redisConnection,
        concurrency: 2,
      },
    );

    this.worker.on("failed", (job, err) => {
      console.error("Job failed", job?.id, err.message);
    });

    this.worker.on("completed", (job) => {
      console.log("Job completed", job.id);
    });
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
    await this.publisher.quit();
  }

  private async process(job: Job<{ taskId: string; apiKey: string; apiUrl?: string; imageApiType?: string }>) {
    const { taskId, apiKey, apiUrl, imageApiType } = job.data;
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { assets: true },
    });

    if (!task) return;
    if (["cancelled", "failed", "succeeded"].includes(task.status)) return;

    await this.prisma.generationTask.update({
      where: { id: task.id },
      data: { status: "running", startedAt: new Date() },
    });

    await this.publish({
      taskId: task.id,
      userId: task.userId,
      status: "running",
      type: task.type as GenerationType,
    });

    try {
      if (task.type === "text_to_image") {
        await this.handleTextToImage(task.id, apiKey, apiUrl, imageApiType);
      } else if (task.type === "image_to_video") {
        await this.handleImageToVideo(task.id, apiKey, apiUrl);
      }
    } catch (error) {
      if (error instanceof TaskCancelledError) return;

      const message = error instanceof Error ? error.message : String(error);
      if (this.shouldRetry(job, error)) {
        console.warn(
          `Retrying task ${task.id} after transient failure (${this.currentAttempt(job)}/${this.maxAttempts(job)}): ${message}`,
        );
        await this.markQueuedForRetry(task.id, task.userId, task.type as GenerationType);
        throw error;
      }

      const finalMessage =
        error instanceof RetryableGenerationError
          ? `Generation failed after ${this.currentAttempt(job)} attempts: ${message}`
          : message;
      await this.markFailed(task.id, "WORKER_EXECUTION_FAILED", finalMessage);
      throw error;
    }
  }

  private async handleTextToImage(taskId: string, apiKey: string, apiUrl?: string, imageApiType?: string) {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { assets: true },
    });
    if (!task) return;

    const params = task.parameters as any;
    const inputAsset = task.assets.find((asset) => asset.role === "input" && asset.mediaType === "image");
    const image = await this.gemini.generateImage({
      model: task.model,
      prompt: task.prompt,
      size: params.size,
      quality: params.quality,
      background: params.background,
      outputFormat: params.outputFormat,
      apiKey,
      apiUrl,
      imageApiType: params.imageApiType || imageApiType,
      referenceImageUrl: params.referenceImageUrl || inputAsset?.url,
      referenceImageUrls: params.referenceImageUrls ?? [],
    });

    const latest = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!latest || latest.status === "cancelled") {
      throw new TaskCancelledError();
    }

    const extension =
      image.mimeType.includes("jpeg") ? "jpg" : image.mimeType.includes("webp") ? "webp" : "png";

    const uploaded = await this.storage.uploadBuffer(image.buffer, {
      prefix: "outputs/images",
      extension,
      contentType: image.mimeType,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.generationAsset.create({
        data: {
          taskId,
          role: "output",
          mediaType: "image",
          url: uploaded.url,
          storageKey: uploaded.key,
          mimeType: image.mimeType,
          sizeBytes: uploaded.sizeBytes,
        },
      });

      await tx.generationTask.update({
        where: { id: taskId },
        data: { status: "succeeded", finishedAt: new Date() },
      });
    });

    // 自动存入素材库（24h 后过期，可归档）
    await this.prisma.material.create({
      data: {
        userId: task.userId,
        name: `generated-${taskId}.${extension}`,
        url: uploaded.url,
        storageKey: uploaded.key,
        mimeType: image.mimeType,
        sizeBytes: uploaded.sizeBytes,
        mediaType: "image",
        source: "generated",
        taskId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await this.publish({
      taskId,
      userId: task.userId,
      status: "succeeded",
      type: "text_to_image",
      assetUrl: uploaded.url,
    });
  }

  private async handleImageToVideo(taskId: string, apiKey: string, apiUrl?: string) {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { assets: true },
    });
    if (!task) return;

    const inputAsset = task.assets.find((a) => a.role === "input" && a.mediaType === "image");
    if (!inputAsset) {
      throw new Error("Input image asset is missing");
    }

    const params = task.parameters as any;
    const operation = await this.gemini.createVideoFromImage({
      model: task.model,
      prompt: task.prompt,
      imageUrl: inputAsset.url,
      aspectRatio: params.aspectRatio,
      size: params.size,
      seconds: params.durationSec || this.env.geminiVideoSeconds,
      apiKey,
      apiUrl,
    });

    await this.prisma.generationTask.update({
      where: { id: taskId },
      data: { providerJobId: operation.name },
    });

    const finalStatus = await this.pollVideoCompletion(taskId, operation.name, apiKey, apiUrl);
    const buffer = await this.gemini.downloadVideo(finalStatus, apiKey, apiUrl);

    const latest = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!latest || latest.status === "cancelled") {
      throw new TaskCancelledError();
    }

    const uploaded = await this.storage.uploadBuffer(buffer, {
      prefix: "outputs/videos",
      extension: "mp4",
      contentType: "video/mp4",
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.generationAsset.create({
        data: {
          taskId,
          role: "output",
          mediaType: "video",
          url: uploaded.url,
          storageKey: uploaded.key,
          mimeType: "video/mp4",
          sizeBytes: uploaded.sizeBytes,
        },
      });

      await tx.generationTask.update({
        where: { id: taskId },
        data: { status: "succeeded", finishedAt: new Date() },
      });
    });

    // 自动存入素材库（24h 后过期，可归档）
    await this.prisma.material.create({
      data: {
        userId: task.userId,
        name: `generated-${taskId}.mp4`,
        url: uploaded.url,
        storageKey: uploaded.key,
        mimeType: "video/mp4",
        sizeBytes: uploaded.sizeBytes,
        mediaType: "video",
        source: "generated",
        taskId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await this.publish({
      taskId,
      userId: task.userId,
      status: "succeeded",
      type: "image_to_video",
      assetUrl: uploaded.url,
    });
  }

  private async pollVideoCompletion(taskId: string, providerJobId: string, apiKey: string, apiUrl?: string) {
    for (;;) {
      await this.sleep(5000);

      const task = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
      if (!task) throw new Error("Task not found while polling video");

      if (task.status === "cancelled") {
        await this.gemini.cancelVideo(providerJobId, apiKey, apiUrl);
        throw new TaskCancelledError();
      }

      const status = await this.gemini.getVideo(providerJobId, apiKey, apiUrl);
      const state = String(status?.status || "").toLowerCase();

      if (["failed", "error", "video_generation_failed", "video_upsampling_failed"].includes(state)) {
        if (!this.extractVideoFailureDetail(status)) {
          throw new RetryableGenerationError(`Video generation failed: ${JSON.stringify(status)}`);
        }
        throw new Error(`Video generation failed: ${JSON.stringify(status)}`);
      }

      if (state === "completed") {
        return status;
      }

      // 其他状态（pending、processing、video_generating 等）继续轮询
    }
  }

  private async markQueuedForRetry(taskId: string, userId: string, type: GenerationType) {
    const updated = await this.prisma.generationTask.updateMany({
      where: {
        id: taskId,
        status: {
          notIn: ["cancelled", "succeeded"],
        },
      },
      data: {
        status: "queued",
        providerJobId: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
      },
    });

    if (updated.count === 0) return;

    await this.publish({
      taskId,
      userId,
      status: "queued",
      type,
    });
  }

  private async markFailed(taskId: string, errorCode: string, errorMessage: string) {
    const task = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
    if (!task) return;
    if (["failed", "cancelled", "succeeded"].includes(task.status)) return;

    await this.prisma.generationTask.update({
      where: { id: taskId },
      data: { status: "failed", finishedAt: new Date(), errorCode, errorMessage },
    });

    await this.publish({
      taskId: task.id,
      userId: task.userId,
      status: "failed",
      type: task.type as GenerationType,
      errorMessage,
    });
  }

  private async publish(event: {
    taskId: string;
    userId: string;
    status: any;
    type: GenerationType;
    errorMessage?: string;
    assetUrl?: string;
  }) {
    await this.publisher.publish(CHANNEL, JSON.stringify(event));
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetry(
    job: Job<{ taskId: string; apiKey: string; apiUrl?: string; imageApiType?: string }>,
    error: unknown,
  ) {
    return error instanceof RetryableGenerationError && this.currentAttempt(job) < this.maxAttempts(job);
  }

  private currentAttempt(
    job: Job<{ taskId: string; apiKey: string; apiUrl?: string; imageApiType?: string }>,
  ) {
    return job.attemptsMade + 1;
  }

  private maxAttempts(
    job: Job<{ taskId: string; apiKey: string; apiUrl?: string; imageApiType?: string }>,
  ) {
    return Math.max(job.opts.attempts ?? 1, 1);
  }

  private extractVideoFailureDetail(status: any) {
    const candidates = [status?.error, status?.message, status?.detail];
    return candidates.find((value) => typeof value === "string" && value.trim()) as string | undefined;
  }
}
