import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

const STATUS_VALUES = ["active", "not_found", "rate_limited", "error", "disabled"] as const;
type Status = (typeof STATUS_VALUES)[number];

export class UpdateTiktokAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  salesTag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsIn(STATUS_VALUES as readonly string[])
  status?: Status;
}
