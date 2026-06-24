import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Transform } from "class-transformer";

export class CreateVideoFromImageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  negativePrompt?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @Transform(({ value }) => (value === "" ? undefined : value))
  @IsUrl({ require_tld: false })
  imageUrl?: string;

  // multipart 单值为 string、多值为 string[]，与 CreateImageDto.referenceImageUrls 一致
  @IsOptional()
  imageUrls?: string | string[];

  @IsOptional()
  @IsIn(["1:1", "16:9", "9:16"])
  aspectRatio?: "1:1" | "16:9" | "9:16";

  @IsOptional()
  @IsIn(["1280x720", "720x1280"])
  size?: "1280x720" | "720x1280";

  @IsOptional()
  @IsIn(["480p", "720p", "1080p"])
  resolution?: "480p" | "720p" | "1080p";

  @IsOptional()
  @Transform(({ value }) => (value !== undefined && value !== "" ? Number(value) : undefined))
  @IsInt()
  @Min(1)
  @Max(15)
  durationSec?: number;

  @IsOptional()
  @IsIn(["standard", "high"])
  quality?: "standard" | "high";
}
