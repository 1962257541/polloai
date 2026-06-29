import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  GenerationType,
  TaskStatus,
  imageToVideoSchema,
  textToImageSchema,
  videoUpscaleSchema,
} from "@packages/shared";
import { ZodError } from "zod";
import { CreateImageDto } from "./dto/create-image.dto";
import { CreateVideoFromImageDto } from "./dto/create-video-from-image.dto";
import { CreateVideoUpscaleDto } from "./dto/create-video-upscale.dto";
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
    files: Express.Multer.File[] = [],
  ) {
    // 上传所有参考图到 S3
    const referenceImages: { key: string; url: string; sizeBytes: number; mimeType: string }[] = [];
    for (const file of files) {
      const uploaded = await this.storageService.uploadBuffer(file.buffer, {
        prefix: "inputs/images",
        extension: this.extensionFromMime(file.mimetype),
        contentType: file.mimetype,
      });
      referenceImages.push({ ...uploaded, mimeType: file.mimetype });
    }

    // 合并：文件上传的 URL + DTO 中直接传入的远程 URL（上下文模式）
    const uploadedUrls = referenceImages.map((r) => r.url);
    // FormData multipart 单个值传过来是 string，多个是 string[]，统一规范化
    const contextUrls = payload.referenceImageUrls
      ? Array.isArray(payload.referenceImageUrls)
        ? payload.referenceImageUrls
        : [payload.referenceImageUrls]
      : [];
    const allReferenceUrls = [...uploadedUrls, ...contextUrls];

    let parsed: ReturnType<typeof textToImageSchema.parse>;
    try {
      parsed = textToImageSchema.parse({
        ...payload,
        referenceImageUrl: allReferenceUrls[0],
        referenceImageUrls: allReferenceUrls,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(error.flatten());
      }
      throw error;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, apiKey: true, apiUrl: true, apiProvider: true, imageModel: true, imageModels: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const apiConfig = await this.resolveEffectiveApiConfig(user, "image");
    if (!apiConfig.apiKey || !apiConfig.apiUrl) {
      throw new BadRequestException("API Key 和 API URL 未配置，请先在当前账号或管理员账号中配置。");
    }

    const availableModels = apiConfig.models;
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
          provider: apiConfig.apiProvider,
          model: imageModel,
          prompt: parsed.prompt,
          negativePrompt: parsed.negativePrompt,
          parameters: parsed,
          sessionId: payload.sessionId ?? null,
        },
      });

      for (const ref of referenceImages) {
        await tx.generationAsset.create({
          data: {
            taskId: created.id,
            role: "input",
            mediaType: "image",
            url: ref.url,
            storageKey: ref.key,
            mimeType: ref.mimeType,
            sizeBytes: ref.sizeBytes,
          },
        });
      }

      return created;
    });

    await this.enqueueTaskOrFail(
      task.id,
      apiConfig.apiKey,
      apiConfig.apiUrl,
      parsed.imageApiType ?? "gemini-native",
      apiConfig.apiProvider,
    );

    await this.notificationsService.publish({
      taskId: task.id,
      userId,
      status: "queued",
      type: "text_to_image",
    });

    return {
      taskId: task.id,
      status: task.status,
      inputImageUrls: referenceImages.map((r) => r.url),
    };
  }

  async createVideoFromImageTask(
    userId: string,
    payload: CreateVideoFromImageDto,
    files: Express.Multer.File[] = [],
  ) {
    // 上传所有参考图到 S3（支持多张）
    const referenceImages: { key: string; url: string; sizeBytes: number; mimeType: string }[] = [];
    for (const file of files) {
      const uploaded = await this.storageService.uploadBuffer(file.buffer, {
        prefix: "inputs/images",
        extension: this.extensionFromMime(file.mimetype),
        contentType: file.mimetype,
      });
      referenceImages.push({ ...uploaded, mimeType: file.mimetype });
    }

    // 合并：文件上传的 URL + DTO 中直接传入的远程 URL（imageUrls 多值 / imageUrl 单值，向后兼容）
    const uploadedUrls = referenceImages.map((r) => r.url);
    const remoteUrls = payload.imageUrls
      ? Array.isArray(payload.imageUrls)
        ? payload.imageUrls
        : [payload.imageUrls]
      : [];
    if (payload.imageUrl) remoteUrls.push(payload.imageUrl);
    const allImageUrls = [...uploadedUrls, ...remoteUrls].filter(Boolean);

    if (allImageUrls.length === 0) {
      throw new BadRequestException("imageUrl/imageUrls or image files are required");
    }

    let parsed: ReturnType<typeof imageToVideoSchema.parse>;
    try {
      parsed = imageToVideoSchema.parse({
        ...payload,
        imageUrl: allImageUrls[0],
        imageUrls: allImageUrls,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(error.flatten());
      }
      throw error;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, apiKey: true, apiUrl: true, apiProvider: true, videoModel: true, videoModels: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const apiConfig = await this.resolveEffectiveApiConfig(user, "video");
    if (!apiConfig.apiKey || !apiConfig.apiUrl) {
      throw new BadRequestException("API Key 和 API URL 未配置，请先在当前账号或管理员账号中配置。");
    }

    const availableModels = apiConfig.models;
    if (parsed.model && !availableModels.includes(parsed.model)) {
      throw new BadRequestException("Selected video model is not enabled for this account");
    }

    const videoModel = parsed.model || availableModels[0];
    if (!videoModel) {
      throw new BadRequestException("No video models are configured for this account");
    }

    // 上传文件对应的 storageKey/元信息便于落库；远程 URL 用 url 自身作 storageKey
    const uploadedByUrl = new Map(referenceImages.map((r) => [r.url, r]));

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.generationTask.create({
        data: {
          userId,
          type: "image_to_video",
          status: "queued",
          provider: apiConfig.apiProvider,
          model: videoModel,
          prompt: parsed.prompt,
          negativePrompt: parsed.negativePrompt,
          parameters: parsed,
        },
      });

      for (const url of allImageUrls) {
        const meta = uploadedByUrl.get(url);
        await tx.generationAsset.create({
          data: {
            taskId: created.id,
            role: "input",
            mediaType: "image",
            url,
            storageKey: meta?.key ?? url,
            mimeType: meta?.mimeType,
            sizeBytes: meta?.sizeBytes,
          },
        });
      }

      return created;
    });

    await this.enqueueTaskOrFail(
      task.id,
      apiConfig.apiKey,
      apiConfig.apiUrl,
      undefined,
      apiConfig.apiProvider,
    );

    await this.notificationsService.publish({
      taskId: task.id,
      userId,
      status: "queued",
      type: "image_to_video",
    });

    return { taskId: task.id, status: task.status, inputImageUrls: allImageUrls };
  }

  async createVideoUpscaleTask(userId: string, payload: CreateVideoUpscaleDto) {
    let parsed: ReturnType<typeof videoUpscaleSchema.parse>;
    try {
      parsed = videoUpscaleSchema.parse(payload);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(error.flatten());
      }
      throw error;
    }

    // 火山画质增强使用平台级 AK/SK（worker env），不依赖用户的 apiKey/apiUrl
    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.generationTask.create({
        data: {
          userId,
          type: "video_upscale",
          status: "queued",
          provider: "volcengine",
          // model 字段复用为目标分辨率标识，便于列表展示与排查
          model: `volc-enhance-${parsed.targetResolution}`,
          prompt: `画质提升至 ${parsed.targetResolution}`,
          parameters: parsed,
        },
      });

      await tx.generationAsset.create({
        data: {
          taskId: created.id,
          role: "input",
          mediaType: "video",
          url: parsed.sourceVideoUrl,
          storageKey: parsed.sourceVideoUrl,
          mimeType: "video/mp4",
        },
      });

      return created;
    });

    // 火山鉴权走 worker env，无需用户 apiKey，传空串占位
    await this.enqueueTaskOrFail(task.id, "");

    await this.notificationsService.publish({
      taskId: task.id,
      userId,
      status: "queued",
      type: "video_upscale",
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

    return this.serializeTask(task);
  }

  async listTasks(
    userId: string,
    input: { status?: string; type?: string; sessionId?: string; limit: number; offset: number },
  ) {
    // type 支持逗号分隔多值（如 "image_to_video,video_upscale"），单值兼容
    const types = input.type
      ? input.type.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    const where = {
      userId,
      ...(input.status ? { status: input.status as TaskStatus } : {}),
      ...(types.length ? { type: { in: types as GenerationType[] } } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
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

    return { items: items.map((item) => this.serializeTask(item)), total };
  }

  async listSessions(
    userId: string,
    input: { type?: string; limit: number; offset: number },
  ) {
    // 查有 sessionId 的任务（按 sessionId 分组）
    // 旧任务 sessionId 为 null，视为各自独立会话，单独查询并合并
    const type = input.type as GenerationType | undefined;

    // 1. 有 sessionId 的任务 — 用原生 SQL groupBy（Prisma groupBy 不支持 include）
    const typeFilter = type ? Prisma.sql`AND "type" = ${type}::"GenerationType"` : Prisma.empty;
    const groupedRaw = await this.prisma.$queryRaw<
      { session_id: string; latest_created_at: Date; task_count: bigint }[]
    >(Prisma.sql`
      SELECT
        "sessionId" AS session_id,
        MAX("createdAt") AS latest_created_at,
        COUNT(*) AS task_count
      FROM "GenerationTask"
      WHERE "userId" = ${userId}
        AND "sessionId" IS NOT NULL
        ${typeFilter}
      GROUP BY "sessionId"
      ORDER BY latest_created_at DESC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `);

    // 2. 旧任务（sessionId = null）— 各自一条记录
    const nullSessionTasks = await this.prisma.generationTask.findMany({
      where: {
        userId,
        sessionId: null,
        ...(type ? { type } : {}),
      },
      include: { assets: true },
      orderBy: { createdAt: "desc" },
      take: input.limit,
      skip: input.offset,
    });

    // 3. 为有 sessionId 的组，批量查最新一条任务（含 assets）
    const sessionIds = groupedRaw.map((r) => r.session_id);
    const latestTasksPerSession = sessionIds.length > 0
      ? await Promise.all(
          sessionIds.map((sid) =>
            this.prisma.generationTask.findFirst({
              where: { userId, sessionId: sid },
              include: { assets: true },
              orderBy: { createdAt: "desc" },
            }),
          ),
        )
      : [];

    // 4. 查各 session 第一条任务（取 sessionTitle 和原始 prompt）
    const firstTasksPerSession = sessionIds.length > 0
      ? await Promise.all(
          sessionIds.map((sid) =>
            this.prisma.generationTask.findFirst({
              where: { userId, sessionId: sid },
              orderBy: { createdAt: "asc" },
              select: { prompt: true, sessionTitle: true },
            }),
          ),
        )
      : [];

    // 5. 组装有 sessionId 的会话摘要
    const sessionItems = groupedRaw.map((row, i) => {
      const latest = latestTasksPerSession[i] ? this.serializeTask(latestTasksPerSession[i]!) : null;
      const first = firstTasksPerSession[i];
      const outputUrl = latest?.assets.find((a) => a.role === "output")?.url;
      return {
        sessionId: row.session_id,
        title: first?.sessionTitle || (first?.prompt?.slice(0, 40) ?? ""),
        taskCount: Number(row.task_count),
        latestCreatedAt: row.latest_created_at,
        outputUrl: outputUrl ?? null,
      };
    });

    // 6. 组装无 sessionId 的独立任务摘要
    const nullItems = nullSessionTasks.map((rawTask) => {
      const task = this.serializeTask(rawTask);
      return {
        sessionId: task.id, // 用 taskId 作为虚拟 sessionId
        title: task.sessionTitle || task.prompt.slice(0, 40),
        taskCount: 1,
        latestCreatedAt: task.createdAt,
        outputUrl: task.assets.find((a) => a.role === "output")?.url ?? null,
        isLegacy: true, // 标记为旧任务
      };
    });

    // 合并按时间排序
    const all = [...sessionItems, ...nullItems].sort(
      (a, b) => new Date(b.latestCreatedAt).getTime() - new Date(a.latestCreatedAt).getTime(),
    );

    return { items: all.slice(0, input.limit) };
  }

  async renameSession(userId: string, sessionId: string, title: string) {
    // 找该 sessionId 最早的任务，更新 sessionTitle
    const task = await this.prisma.generationTask.findFirst({
      where: { userId, sessionId },
      orderBy: { createdAt: "asc" },
    });

    if (!task) {
      // 可能是旧任务（用 taskId 作为 sessionId）
      const legacyTask = await this.prisma.generationTask.findFirst({
        where: { id: sessionId, userId },
      });
      if (!legacyTask) throw new NotFoundException("Session not found");
      await this.prisma.generationTask.update({
        where: { id: sessionId },
        data: { sessionTitle: title },
      });
      return { success: true };
    }

    await this.prisma.generationTask.update({
      where: { id: task.id },
      data: { sessionTitle: title },
    });
    return { success: true };
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

    // 如果任务正在进行中，先标记为 cancelled，让 Worker 检测到后自行退出
    if (task.status === "queued" || task.status === "running") {
      await this.prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: "cancelled",
          finishedAt: new Date(),
          errorCode: "TASK_CANCELLED",
          errorMessage: "Cancelled by user",
        },
      });

      // 同时尝试从队列移除（queued 阶段尚未被 Worker 取走时有效）
      const job = await this.queue.getJob(taskId);
      if (job) await job.remove();

      await this.notificationsService.publish({
        taskId,
        userId,
        status: "cancelled",
        type: task.type as GenerationType,
        errorMessage: "Cancelled by user",
      });
    }

    await this.prisma.generationTask.delete({ where: { id: taskId } });
    return { success: true };
  }

  async deleteAllTasks(
    userId: string,
    opts: { type?: string; onlyTerminated?: boolean } = {},
  ) {
    const where: any = { userId };
    if (opts.type) {
      const types = opts.type.split(",").map((t) => t.trim()).filter(Boolean);
      if (types.length === 1) where.type = types[0];
      else if (types.length > 1) where.type = { in: types };
    }
    if (opts.onlyTerminated) {
      where.status = { in: ["succeeded", "failed", "cancelled"] };
    }

    const tasks = await this.prisma.generationTask.findMany({
      where,
      select: { id: true, status: true },
    });

    for (const task of tasks) {
      if (task.status === "queued" || task.status === "running") {
        const job = await this.queue.getJob(task.id);
        if (job) await job.remove();
      }
    }

    const { count } = await this.prisma.generationTask.deleteMany({ where });
    return { deleted: count };
  }

  private async findAdminApiFallback() {
    return this.prisma.user.findFirst({
      where: {
        role: "admin",
        apiKey: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: {
        apiKey: true,
        apiUrl: true,
        apiProvider: true,
        imageModel: true,
        imageModels: true,
        videoModel: true,
        videoModels: true,
      },
    });
  }

  private async resolveEffectiveApiConfig(
    user: {
      role: string;
      apiKey: string | null;
      apiUrl: string | null;
      apiProvider: string;
      imageModel?: string | null;
      imageModels?: string[] | null;
      videoModel?: string | null;
      videoModels?: string[] | null;
    },
    kind: "image" | "video",
  ) {
    const adminFallback = user.role === "admin" ? null : await this.findAdminApiFallback();
    const ownModels = kind === "image"
      ? this.normalizeConfiguredModels(user.imageModels, user.imageModel)
      : this.normalizeConfiguredModels(user.videoModels, user.videoModel);
    const fallbackModels = kind === "image"
      ? this.normalizeConfiguredModels(adminFallback?.imageModels, adminFallback?.imageModel)
      : this.normalizeConfiguredModels(adminFallback?.videoModels, adminFallback?.videoModel);

    return {
      apiKey: user.apiKey || adminFallback?.apiKey || null,
      apiUrl: user.apiUrl || adminFallback?.apiUrl || null,
      apiProvider: user.apiUrl ? user.apiProvider : (adminFallback?.apiProvider ?? user.apiProvider ?? "yunwu"),
      models: ownModels.length ? ownModels : fallbackModels,
    };
  }

  private async enqueueTaskOrFail(
    taskId: string,
    apiKey: string,
    apiUrl?: string,
    imageApiType?: string,
    provider?: string,
  ) {
    try {
      await this.queue.add(
        "process-generation",
        { taskId, apiKey, apiUrl, imageApiType, provider },
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

  private serializeTask<T extends { assets: Array<{ url: string; storageKey: string | null }> }>(task: T): T {
    return {
      ...task,
      assets: task.assets.map((asset) => ({
        ...asset,
        url: this.storageService.resolvePublicUrl(asset.url, asset.storageKey),
      })),
    };
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
