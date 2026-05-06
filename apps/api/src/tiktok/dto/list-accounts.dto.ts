import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";

const STATUS_VALUES = ["active", "cookie_expired", "captcha_blocked", "error", "disabled"] as const;

export class ListAccountsQueryDto {
  @IsOptional()
  @IsIn(STATUS_VALUES as readonly string[])
  status?: (typeof STATUS_VALUES)[number];

  @IsOptional()
  @IsString()
  q?: string;

  /** admin 专用：'all' 看全部，'mine' 仅看自己（默认） */
  @IsOptional()
  @IsIn(["all", "mine"])
  scope?: "all" | "mine";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
