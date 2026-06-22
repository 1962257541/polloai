import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ApiProvider, CreateSalespersonDto, SalespersonInfo } from "@packages/shared";
import bcrypt from "bcryptjs";

@Injectable()
export class AdminService {
  private static readonly MAX_MODEL_COUNT = 200;

  constructor(private readonly prisma: PrismaService) {}

  async listSalespersons(): Promise<SalespersonInfo[]> {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        apiKey: true,
        apiUrl: true,
        apiProvider: true,
        imageModel: true,
        imageModels: true,
        videoModel: true,
        videoModels: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      hasApiKey: Boolean(u.apiKey),
      hasApiUrl: Boolean(u.apiUrl),
      apiUrl: u.apiUrl,
      apiProvider: u.apiProvider as ApiProvider,
      imageModel: u.imageModel,
      imageModels: this.normalizeConfiguredModels(u.imageModels, u.imageModel),
      videoModel: u.videoModel,
      videoModels: this.normalizeConfiguredModels(u.videoModels, u.videoModel),
    }));
  }

  async createSalesperson(dto: CreateSalespersonDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new BadRequestException("Email already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        passwordHash,
        role: "salesperson",
      },
      select: { id: true, email: true, name: true, role: true },
    });

    return user;
  }

  async deleteSalesperson(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    if (user.role !== "salesperson") {
      throw new BadRequestException("Cannot delete non-salesperson accounts");
    }

    await this.prisma.user.delete({ where: { id } });
    return { success: true };
  }

  async updateApiConfig(
    targetUserId: string,
    apiKey: string | undefined,
    apiUrl: string,
    apiProvider?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        ...(apiKey ? { apiKey } : {}),
        apiUrl,
        ...(apiProvider ? { apiProvider } : {}),
      },
    });

    return { success: true };
  }

  // APIMart（apib.ai）无标准 /v1/models 目录接口，提供内置候选清单作为种子，
  // 用户也可在配置界面手动添加任意模型 ID。
  private static readonly APIMART_MODEL_CATALOG = [
    // 图片
    "gemini-3.1-flash-image-preview",
    "gemini-3.1-flash-image-preview-official",
    "gpt-image-2",
    "qwen-image",
    "imagen-4.0",
    "midjourney",
    // 视频
    "veo3.1-fast",
    "veo3.1-quality",
    "veo3.1-lite",
    "sora-2",
    "kling-v3",
    "wan2.7",
  ];

  async listRemoteModels(targetUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { apiKey: true, apiUrl: true, apiProvider: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (!user.apiKey || !user.apiUrl) {
      throw new BadRequestException("API key and API URL must be configured before loading models");
    }

    // apimart 没有远端模型目录接口，直接返回内置候选清单
    if (user.apiProvider === "apimart") {
      return { models: [...AdminService.APIMART_MODEL_CATALOG].sort((a, b) => a.localeCompare(b)) };
    }

    const response = await fetch(this.modelsUrl(user.apiUrl), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${user.apiKey}`,
      },
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new BadRequestException(`Model catalog returned non-JSON response (${response.status})`);
      }
    }

    if (!response.ok) {
      throw new BadRequestException(
        `Failed to load remote models (${response.status}): ${this.stringifyErrorPayload(payload)}`,
      );
    }

    return {
      models: this.normalizeRemoteModels(payload),
    };
  }

  async updateModelConfig(targetUserId: string, imageModels: string[], videoModels: string[]) {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    const normalizedImageModels = this.deduplicateModels(imageModels);
    const normalizedVideoModels = this.deduplicateModels(videoModels);

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        imageModels: normalizedImageModels,
        imageModel: normalizedImageModels[0] ?? null,
        videoModels: normalizedVideoModels,
        videoModel: normalizedVideoModels[0] ?? null,
      },
    });

    return { success: true };
  }

  async getMyInfo(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        apiKey: true,
        apiUrl: true,
        apiProvider: true,
        imageModel: true,
        imageModels: true,
        videoModel: true,
        videoModels: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      hasApiKey: Boolean(user.apiKey),
      hasApiUrl: Boolean(user.apiUrl),
      apiProvider: user.apiProvider,
      imageModel: user.imageModel,
      imageModels: this.normalizeConfiguredModels(user.imageModels, user.imageModel),
      videoModel: user.videoModel,
      videoModels: this.normalizeConfiguredModels(user.videoModels, user.videoModel),
    };
  }

  private normalizeConfiguredModels(models: string[] | null | undefined, fallback?: string | null) {
    return this.deduplicateModels([...(models ?? []), ...(fallback ? [fallback] : [])]);
  }

  private deduplicateModels(models: string[]) {
    const unique = Array.from(
      new Set(
        models
          .map((model) => model.trim())
          .filter(Boolean),
      ),
    );

    if (unique.length > AdminService.MAX_MODEL_COUNT) {
      throw new BadRequestException(`A maximum of ${AdminService.MAX_MODEL_COUNT} models can be configured`);
    }

    return unique;
  }

  private normalizeRemoteModels(payload: unknown) {
    const rawItems = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown[] } | null)?.data)
        ? (payload as { data: unknown[] }).data
        : Array.isArray((payload as { models?: unknown[] } | null)?.models)
          ? (payload as { models: unknown[] }).models
          : [];

    const ids = rawItems
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
          return item.id.trim();
        }
        return "";
      })
      .filter(Boolean);

    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }

  private modelsUrl(apiUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new BadRequestException("Configured API URL is invalid");
    }

    // 保留原始 pathname，智能拼接 /models
    // 支持 https://host/v1、https://host/path/v1、https://host 等格式
    let pathname = parsed.pathname;
    if (pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    if (pathname.endsWith("/v1")) {
      return `${parsed.protocol}//${parsed.host}${pathname}/models`;
    }
    if (pathname === "" || pathname === "/") {
      return `${parsed.protocol}//${parsed.host}/v1/models`;
    }
    return `${parsed.protocol}//${parsed.host}${pathname}/v1/models`;
  }

  private stringifyErrorPayload(payload: unknown) {
    if (!payload) {
      return "empty response";
    }
    if (typeof payload === "string") {
      return payload;
    }
    try {
      return JSON.stringify(payload).slice(0, 500);
    } catch {
      return String(payload);
    }
  }
}
