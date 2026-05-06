import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EnvService } from "../config/env.service";

const ALGO = "aes-256-gcm";

export interface EncryptedBlob {
  enc: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * 用 TIKTOK_BOOT_KEY 加解密 SystemConfig 表中的敏感字段（如 tiktok.cookieKey）。
 * 业务侧再用解密出来的 tiktok.cookieKey 加密 TiktokAccount.storageState。
 */
@Injectable()
export class SystemConfigCryptoService {
  constructor(private readonly env: EnvService) {}

  private requireBootKey(): Buffer {
    const key = this.env.tiktokBootKey;
    if (!key) {
      throw new InternalServerErrorException(
        "TIKTOK_BOOT_KEY 未配置，无法读写敏感系统配置",
      );
    }
    return key;
  }

  encryptWithBoot(plain: Buffer | string): EncryptedBlob {
    const key = this.requireBootKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const data = Buffer.isBuffer(plain) ? plain : Buffer.from(plain, "utf8");
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    return { enc, iv, tag: cipher.getAuthTag() };
  }

  decryptWithBoot(blob: EncryptedBlob): Buffer {
    const key = this.requireBootKey();
    const decipher = createDecipheriv(ALGO, key, blob.iv);
    decipher.setAuthTag(blob.tag);
    return Buffer.concat([decipher.update(blob.enc), decipher.final()]);
  }

  /**
   * 用业务密钥（解密后的 tiktok.cookieKey）加密任意 JSON。
   * TiktokAccount.storageState 通过此方法加密。
   */
  encryptWithKey(key: Buffer, plain: unknown): EncryptedBlob {
    if (key.length !== 32) {
      throw new InternalServerErrorException("业务密钥长度必须为 32 字节");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(plain), "utf8"),
      cipher.final(),
    ]);
    return { enc, iv, tag: cipher.getAuthTag() };
  }

  decryptWithKey<T = unknown>(key: Buffer, blob: EncryptedBlob): T {
    const decipher = createDecipheriv(ALGO, key, blob.iv);
    decipher.setAuthTag(blob.tag);
    const plain = Buffer.concat([decipher.update(blob.enc), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  }
}
