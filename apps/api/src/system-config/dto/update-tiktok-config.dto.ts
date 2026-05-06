import { IsInt, IsOptional, IsUrl, Max, Min } from "class-validator";

/**
 * 配置页 [保存配置] 提交的 body。
 * 不含敏感字段（cookieKey 走独立 rotate / reset 端点）。
 */
export class UpdateTiktokConfigDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  affiliateOverviewUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(30_000)
  @Max(300_000)
  scrapeTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  browserPoolSize?: number;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(1440)
  defaultIntervalMin?: number;
}
