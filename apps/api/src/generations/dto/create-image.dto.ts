import { imageApiTypeValues } from "@packages/shared";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateImageDto {
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
  @IsIn(["1024x1024", "1024x1536", "1536x1024", "1024x1792"])
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "1024x1792";

  @IsOptional()
  @IsIn(["low", "medium", "high", "auto"])
  quality?: "low" | "medium" | "high" | "auto";

  @IsOptional()
  @IsIn(["transparent", "opaque", "auto"])
  background?: "transparent" | "opaque" | "auto";

  @IsOptional()
  @IsIn(["png", "jpeg", "webp"])
  outputFormat?: "png" | "jpeg" | "webp";

  @IsOptional()
  @IsIn(imageApiTypeValues)
  imageApiType?: "openai-images" | "gemini-native";
}
