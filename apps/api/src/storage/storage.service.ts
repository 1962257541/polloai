import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EnvService } from "../config/env.service";
import { randomUUID } from "crypto";

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly env: EnvService) {
    this.client = new S3Client({
      region: env.s3Region,
      endpoint: env.s3Endpoint,
      forcePathStyle: env.s3ForcePathStyle,
      credentials: {
        accessKeyId: env.s3AccessKey,
        secretAccessKey: env.s3SecretKey,
      },
    });
  }

  async onModuleInit() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.env.s3Bucket }));
    } catch (error) {
      this.logger.warn(`Failed to access storage bucket on startup: ${(error as Error).message}`);

      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.env.s3Bucket }));
      } catch (createError) {
        this.logger.warn(`Failed to create storage bucket on startup: ${(createError as Error).message}`);
        return;
      }
    }

    await this.ensurePublicReadPolicy();
  }

  buildPublicUrl(key: string) {
    const baseUrl = this.env.s3PublicBaseUrl.replace(/\/+$/, "");
    const normalizedKey = key.replace(/^\/+/, "");
    return `${baseUrl}/${normalizedKey}`;
  }

  resolvePublicUrl(url: string, storageKey?: string | null) {
    if (!storageKey || /^https?:\/\//i.test(storageKey)) {
      return url;
    }
    return this.buildPublicUrl(storageKey);
  }

  async uploadBuffer(
    buffer: Buffer,
    input: {
      prefix: string;
      extension: string;
      contentType: string;
    },
  ) {
    const key = `${input.prefix}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${input.extension}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.s3Bucket,
        Key: key,
        Body: buffer,
        ContentType: input.contentType,
      }),
    );

    return {
      key,
      url: this.buildPublicUrl(key),
      sizeBytes: buffer.byteLength,
    };
  }

  private async ensurePublicReadPolicy() {
    try {
      await this.client.send(
        new PutBucketPolicyCommand({
          Bucket: this.env.s3Bucket,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowPublicRead",
                Effect: "Allow",
                Principal: "*",
                Action: ["s3:GetObject"],
                Resource: [`arn:aws:s3:::${this.env.s3Bucket}/*`],
              },
            ],
          }),
        }),
      );
    } catch (error) {
      this.logger.warn(`Failed to apply public read policy on startup: ${(error as Error).message}`);
    }
  }
}
