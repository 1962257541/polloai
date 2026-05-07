import { IsOptional, IsString, Matches, MaxLength, ValidateIf } from "class-validator";

/**
 * 创建账号：handle 或 uid 二选一即可（at least one required）。
 * 手动运营字段（salesTag/category/region/note）全部可选。
 */
export class CreateTiktokAccountDto {
  @ValidateIf((o) => !o.uid)
  @IsString({ message: "handle 或 uid 至少填一个" })
  @Matches(/^@?[A-Za-z0-9._]{2,24}$/, {
    message: "handle 必须是 2-24 位的字母/数字/下划线/点，可带 @ 前缀",
  })
  handle?: string;

  @ValidateIf((o) => !o.handle)
  @IsString({ message: "handle 或 uid 至少填一个" })
  @Matches(/^\d{15,20}$/, { message: "uid 必须是 15-20 位数字" })
  uid?: string;

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
}
