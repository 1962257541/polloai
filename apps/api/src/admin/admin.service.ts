import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateSalespersonDto, SalespersonInfo } from "@packages/shared";
import bcrypt from "bcryptjs";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listSalespersons(): Promise<SalespersonInfo[]> {
    const users = await this.prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, apiKey: true, apiUrl: true, imageModel: true, imageApiType: true, videoModel: true },
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
      imageModel: u.imageModel,
      imageApiType: u.imageApiType as any,
      videoModel: u.videoModel,
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

  async updateApiConfig(targetUserId: string, apiKey: string | undefined, apiUrl: string, imageModel?: string, imageApiType?: string, videoModel?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        ...(apiKey ? { apiKey } : {}),
        apiUrl,
        imageModel: imageModel || null,
        imageApiType: imageApiType || "openai-images",
        videoModel: videoModel || null,
      },
    });

    return { success: true };
  }

  async getMyInfo(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, apiKey: true, apiUrl: true, imageModel: true, imageApiType: true, videoModel: true },
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
      imageModel: user.imageModel,
      imageApiType: user.imageApiType,
      videoModel: user.videoModel,
    };
  }
}
