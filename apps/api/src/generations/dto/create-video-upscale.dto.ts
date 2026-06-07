import { videoUpscaleResolutionValues } from "@packages/shared";
import { IsIn, IsOptional, IsString, IsUrl } from "class-validator";
import { Transform } from "class-transformer";

export class CreateVideoUpscaleDto {
  @Transform(({ value }) => (value === "" ? undefined : value))
  @IsUrl({ require_tld: false })
  sourceVideoUrl!: string;

  @IsOptional()
  @IsIn(videoUpscaleResolutionValues)
  targetResolution?: "1080p" | "2k" | "4k";

  @IsOptional()
  @IsString()
  sourceTaskId?: string;
}
