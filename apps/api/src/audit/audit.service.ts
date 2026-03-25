import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: {
    userId?: string;
    method: string;
    path: string;
    statusCode: number;
    requestId: string;
    details?: unknown;
  }) {
    try {
      await this.prisma.apiAuditLog.create({
        data: {
          userId: input.userId,
          method: input.method,
          path: input.path,
          statusCode: input.statusCode,
          requestId: input.requestId,
          details: input.details as any,
        },
      });
    } catch {
      // 忽略审计日志写入失败（如外键约束：userId 不存在），不影响主流程
    }
  }
}
