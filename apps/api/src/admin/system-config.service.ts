import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * 火山引擎画质增强（视频超分）平台级配置。
 *
 * 存储：统一落 SystemConfig 表，category="volc"，每项一行（valuePlain 明文，
 * 与现有 User.apiKey 明文水位一致；isSecret 仅用于前端脱敏回显）。
 * 读取优先级：DB > env > 硬编码默认值（与 worker EnvService 默认值保持一致）。
 */
export const VOLC_CATEGORY = "volc";

export interface VolcFieldDef {
  /** SystemConfig.key */
  key: string;
  /** API / 前端字段名 */
  field: string;
  /** 回退用的 env 变量名 */
  env: string;
  /** 硬编码默认值（须与 worker EnvService 的 default 保持一致） */
  fallback: string;
  /** 是否密钥（脱敏回显、空值不覆盖） */
  secret: boolean;
}

export const VOLC_FIELDS: VolcFieldDef[] = [
  { key: "volc.apiKey", field: "apiKey", env: "VOLC_API_KEY", fallback: "", secret: true },
  { key: "volc.host", field: "host", env: "VOLC_HOST", fallback: "mediakit.cn-beijing.volces.com", secret: false },
  { key: "volc.toolVersion", field: "toolVersion", env: "VOLC_TOOL_VERSION", fallback: "standard", secret: false },
  { key: "volc.resolution", field: "resolution", env: "VOLC_RESOLUTION", fallback: "", secret: false },
];

export type VolcConfigInput = Partial<Record<string, string>>;

@Injectable()
export class SystemConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /** 返回当前火山配置（密钥脱敏回显）。 */
  async getVolcConfig() {
    const rows = await this.prisma.systemConfig.findMany({ where: { category: VOLC_CATEGORY } });
    const dbMap = new Map(rows.map((r) => [r.key, r.valuePlain ?? ""]));

    const view: Record<string, unknown> = {};
    for (const def of VOLC_FIELDS) {
      const resolved = this.resolve(dbMap, def);
      if (def.secret) {
        view[def.field] = this.mask(resolved);
        view[`has${this.cap(def.field)}`] = Boolean(resolved);
      } else {
        view[def.field] = resolved;
      }
    }
    const apiKeyDef = VOLC_FIELDS.find((d) => d.field === "apiKey")!;
    view.configured = Boolean(this.resolve(dbMap, apiKeyDef));
    return view;
  }

  /** 整体更新；密钥字段传空/缺省表示「保持不变」。 */
  async updateVolcConfig(input: VolcConfigInput, updatedBy?: string) {
    for (const def of VOLC_FIELDS) {
      const incoming = input[def.field];
      // 未传该字段 → 不动
      if (incoming === undefined) continue;
      // 密钥字段传空字符串 → 视为「保持不变」，避免脱敏占位被误存
      if (def.secret && incoming.trim() === "") continue;

      const value = incoming.trim();
      await this.prisma.systemConfig.upsert({
        where: { key: def.key },
        create: {
          key: def.key,
          category: VOLC_CATEGORY,
          isSecret: def.secret,
          valuePlain: value,
          updatedBy,
        },
        update: { valuePlain: value, isSecret: def.secret, updatedBy },
      });
    }
    return this.getVolcConfig();
  }

  private resolve(dbMap: Map<string, string>, def: VolcFieldDef): string {
    const fromDb = dbMap.get(def.key);
    if (fromDb && fromDb.length > 0) return fromDb;
    const fromEnv = process.env[def.env];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    return def.fallback;
  }

  private mask(value: string): string {
    if (!value) return "";
    if (value.length <= 4) return "****";
    return `****${value.slice(-4)}`;
  }

  private cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
