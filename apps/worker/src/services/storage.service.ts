import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { EnvService } from "./env.service";
import { randomUUID } from "crypto";

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;

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
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.env.s3Bucket }));
    }
  }

  async uploadBuffer(
    buffer: Buffer,
    input: { prefix: string; extension: string; contentType: string },
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
      url: `${this.env.s3PublicBaseUrl}/${key}`,
      sizeBytes: buffer.byteLength,
    };
  }
}
