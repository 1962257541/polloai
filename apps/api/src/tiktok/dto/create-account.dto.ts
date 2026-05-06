import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";

export class CreateTiktokAccountDto {
  @IsString()
  @Matches(/^@?[A-Za-z0-9._]{2,24}$/, {
    message: "handle 必须是 2-24 位的字母/数字/下划线/点，可带 @ 前缀",
  })
  handle!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(1440)
  scrapeIntervalMin?: number;
}
