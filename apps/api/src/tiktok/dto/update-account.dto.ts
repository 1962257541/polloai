import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

const STATUS_VALUES = ["active", "cookie_expired", "captcha_blocked", "error", "disabled"] as const;
type Status = (typeof STATUS_VALUES)[number];

export class UpdateTiktokAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(1440)
  scrapeIntervalMin?: number;

  @IsOptional()
  @IsIn(STATUS_VALUES as readonly string[])
  status?: Status;
}
