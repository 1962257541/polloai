import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import Redis from "ioredis";
import { EnvService } from "./env.service";
import { PrismaService } from "./prisma.service";
import { StorageService } from "./storage.service";
import { GeminiService } from "./gemini.service";
import { ApimartService } from "./apimart.service";
import { DoubaoService } from "./doubao.service";
import { GenerationProvider } from "./generation-provider";
import { VolcEngineService } from "./volcengine.service";
import { GenerationType } from "@packages/shared";

const QUEUE_NAME = "generation-jobs";
const CHANNEL = "generation-status";

/** 入队任务负载：provider 决定走 yunwu(GeminiService) 还是 apimart(ApimartService) */
type GenerationJobData = {
  taskId: string;
  apiKey: string;
  apiUrl?: string;
  imageApiType?: string;
  provider?: string;
};

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
    private readonly apimart: ApimartService,
    private readonly doubao: DoubaoService,
    private readonly volc: VolcEngineService,
  ) {
    this.publisher = new Redis(env.redisUrl);
  }

  /** 按账号供应商选择具体适配器（策略模式）；默认 yunwu */
  private providerFor(provider?: string): GenerationProvider {
    if (provider === "apimart") return this.apimart;
    if (provider === "doubao") return this.doubao;
    return this.gemini;
  }

  async onModuleInit() {
    // 启动时将上次遗留的 queued/running 任务标记为 failed（服务重启导致的僵尸任务）
    await this.markStalledTasksFailed();

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

  /** 将因服务重启而卡在 queued/running 状态的任务批量标记为 failed */
  private async markStalledTasksFailed() {
    try {
      const result = await this.prisma.generationTask.updateMany({
        where: { status: { in: ["queued", "running"] } },
        data: {
          status: "failed",
          errorMessage: "服务重启，任务中断。请使用重试功能重新生成。",
          finishedAt: new Date(),
        },
      });
      if (result.count > 0) {
        console.log(`[Worker startup] Marked ${result.count} stalled task(s) as failed.`);
      }
    } catch (err) {
      console.error("[Worker startup] Failed to mark stalled tasks:", err);
    }
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
    await this.publisher.quit();
  }

  private async process(job: Job<GenerationJobData>) {
    const { taskId, apiKey, apiUrl, imageApiType, provider } = job.data;
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
        await this.handleTextToImage(task.id, apiKey, apiUrl, imageApiType, provider);
      } else if (task.type === "image_to_video") {
        await this.handleImageToVideo(task.id, apiKey, apiUrl, provider);
      } else if (task.type === "video_upscale") {
        await this.handleVideoUpscale(task.id);
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

  private async handleTextToImage(
    taskId: string,
    apiKey: string,
    apiUrl?: string,
    imageApiType?: string,
    provider?: string,
  ) {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { assets: true },
    });
    if (!task) return;

    const svc = this.providerFor(provider);
    const params = task.parameters as any;
    const inputAsset = task.assets.find((asset) => asset.role === "input" && asset.mediaType === "image");

    // 合并所有参考图 URL
    const referenceImageUrls = params.referenceImageUrls ?? [];

    // 多模态提示词增强
    let finalPrompt = task.prompt;
    let enhancedPrompt: string | undefined;

    if (referenceImageUrls.length > 0) {
      console.log(`[handleTextToImage] Attempting prompt enhancement with ${referenceImageUrls.length} reference images`);
      try {
        enhancedPrompt = await svc.enhancePrompt({
          originalPrompt: task.prompt,
          referenceImageUrls,
          apiKey,
          apiUrl,
        });

        // 只有当增强结果与原始不同时才使用
        if (enhancedPrompt !== task.prompt) {
          finalPrompt = enhancedPrompt;
          console.log(`[handleTextToImage] Using enhanced prompt for task ${taskId}`);
        }
      } catch (error) {
        console.warn(`[handleTextToImage] Prompt enhancement failed, using original prompt:`, error);
        // 降级：继续使用原始 prompt
      }
    }

    const image = await svc.generateImage({
      model: task.model,
      prompt: finalPrompt,
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

    if (image.kind === "text") {
      await this.prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          parameters: this.withEnhancedPrompt(params, enhancedPrompt, image.responseText),
        },
      });

      await this.publish({
        taskId,
        userId: task.userId,
        status: "succeeded",
        type: "text_to_image",
        responseText: image.responseText,
      });
      return;
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
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          parameters: this.withEnhancedPrompt(params, enhancedPrompt),
        },
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

  private async handleImageToVideo(taskId: string, apiKey: string, apiUrl?: string, provider?: string) {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { assets: true },
    });
    if (!task) return;

    const svc = this.providerFor(provider);
    const inputAssets = task.assets.filter((a) => a.role === "input" && a.mediaType === "image");
    if (inputAssets.length === 0) {
      throw new Error("Input image asset is missing");
    }

    const params = task.parameters as any;
    const imageUrls = inputAssets.map((a) => a.url);
    // 诊断日志：确认用户选择的秒数与参考图数量已正确传到 worker
    console.log(
      `[handleImageToVideo] taskId=${taskId} images=${imageUrls.length} params.durationSec=${params.durationSec} (${typeof params.durationSec}), env default=${this.env.geminiVideoSeconds}`,
    );
    const operation = await svc.createVideoFromImage({
      model: task.model,
      prompt: task.prompt,
      imageUrls,
      aspectRatio: params.aspectRatio,
      size: params.size,
      resolution: params.resolution,
      // 用 ?? 而非 ||，避免未来 0 等假值边界
      seconds: params.durationSec ?? this.env.geminiVideoSeconds,
      apiKey,
      apiUrl,
    });

    await this.prisma.generationTask.update({
      where: { id: taskId },
      data: { providerJobId: operation.name },
    });

    const finalStatus = await this.pollVideoCompletion(taskId, operation.name, apiKey, apiUrl, provider);
    const buffer = await svc.downloadVideo(finalStatus, apiKey, apiUrl);

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

  private async handleVideoUpscale(taskId: string) {
    if (!(await this.volc.isConfigured())) {
      throw new Error("未配置火山 MediaKit API Key（系统设置→画质提升，或 VOLC_API_KEY），无法执行画质提升。");
    }

    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { assets: true },
    });
    if (!task) return;

    const inputAsset = task.assets.find((a) => a.role === "input" && a.mediaType === "video");
    if (!inputAsset) {
      throw new Error("Input video asset is missing");
    }

    const params = task.parameters as any;
    // 目标分辨率来自任务参数；缺省时由 VolcEngineService 内部按 DB/env 配置兜底
    const resolution = params.targetResolution || undefined;
    console.log(`[handleVideoUpscale] taskId=${taskId} resolution=${resolution} source=${inputAsset.url}`);

    const submit = await this.volc.submitEnhanceTask({
      videoUrl: inputAsset.url,
      resolution,
    });

    await this.prisma.generationTask.update({
      where: { id: taskId },
      data: { providerJobId: submit.taskId },
    });

    const result = await this.pollVolcEnhance(taskId, submit.taskId);
    const buffer = await this.volc.downloadResult(result.outputVideoUrl!);

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

    // 高清结果自动存入素材库（24h 后过期）
    await this.prisma.material.create({
      data: {
        userId: task.userId,
        name: `enhanced-${taskId}.mp4`,
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
      type: "video_upscale",
      assetUrl: uploaded.url,
    });
  }

  /** 轮询火山画质增强任务，直到完成 / 失败 / 取消 */
  private async pollVolcEnhance(taskId: string, providerJobId: string) {
    for (;;) {
      await this.sleep(5000);

      const task = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
      if (!task) throw new Error("Task not found while polling enhance");
      if (task.status === "cancelled") throw new TaskCancelledError();

      const result = await this.volc.queryEnhanceTask(providerJobId);
      if (result.failed) {
        throw new Error(`火山画质增强失败: ${JSON.stringify(result.raw).slice(0, 500)}`);
      }
      if (result.done) {
        if (!result.outputVideoUrl) {
          throw new Error(`火山画质增强完成但缺少结果视频地址: ${JSON.stringify(result.raw).slice(0, 500)}`);
        }
        return result;
      }
      // 其他状态继续轮询
    }
  }

  private async pollVideoCompletion(
    taskId: string,
    providerJobId: string,
    apiKey: string,
    apiUrl?: string,
    provider?: string,
  ) {
    const svc = this.providerFor(provider);
    for (;;) {
      await this.sleep(5000);

      const task = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
      if (!task) throw new Error("Task not found while polling video");

      if (task.status === "cancelled") {
        await svc.cancelVideo(providerJobId, apiKey, apiUrl);
        throw new TaskCancelledError();
      }

      const status = await svc.getVideo(providerJobId, apiKey, apiUrl);
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
    responseText?: string;
  }) {
    await this.publisher.publish(CHANNEL, JSON.stringify(event));
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetry(
    job: Job<GenerationJobData>,
    error: unknown,
  ) {
    return error instanceof RetryableGenerationError && this.currentAttempt(job) < this.maxAttempts(job);
  }

  private currentAttempt(
    job: Job<GenerationJobData>,
  ) {
    return job.attemptsMade + 1;
  }

  private maxAttempts(
    job: Job<GenerationJobData>,
  ) {
    return Math.max(job.opts.attempts ?? 1, 1);
  }

  private extractVideoFailureDetail(status: any) {
    const candidates = [status?.error, status?.message, status?.detail];
    return candidates.find((value) => typeof value === "string" && value.trim()) as string | undefined;
  }

  private withResponseText(parameters: unknown, responseText: string) {
    const base =
      parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? (parameters as Record<string, unknown>)
        : {};

    return {
      ...base,
      responseText,
    };
  }

  private withEnhancedPrompt(parameters: unknown, enhancedPrompt?: string, responseText?: string) {
    const base =
      parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? (parameters as Record<string, unknown>)
        : {};

    return {
      ...base,
      ...(enhancedPrompt ? { enhancedPrompt } : {}),
      ...(responseText ? { responseText } : {}),
    };
  }
}
