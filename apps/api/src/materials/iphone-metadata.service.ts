import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import ffmpegStatic from "ffmpeg-static";

const IPHONE_MODELS = [
  "iPhone 13",
  "iPhone 13 Pro",
  "iPhone 14",
  "iPhone 14 Pro",
  "iPhone 15",
  "iPhone 15 Pro",
  "iPhone 16",
  "iPhone 16 Pro",
];

const IOS_VERSIONS = ["17.5.1", "17.6.1", "18.1.1", "18.2", "18.2.1"];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatQuickTimeDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const tzMin = -date.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const tzh = pad(Math.floor(Math.abs(tzMin) / 60));
  const tzm = pad(Math.abs(tzMin) % 60);
  return `${y}-${M}-${d}T${h}:${m}:${s}${sign}${tzh}${tzm}`;
}

@Injectable()
export class IphoneMetadataService {
  private readonly logger = new Logger(IphoneMetadataService.name);
  private readonly ffmpegPath: string;

  constructor() {
    const resolved = (ffmpegStatic as unknown as string) || "";
    if (!resolved) {
      this.logger.warn("ffmpeg-static binary not resolved; iPhone metadata injection will fail");
    }
    this.ffmpegPath = resolved;
  }

  /**
   * 把视频 buffer 写入临时文件，调用 ffmpeg 注入 iPhone 元数据后输出 mov，
   * 一次性读回 buffer 并清理临时文件。
   */
  async transformBuffer(input: Buffer, opts: { creationDate?: Date } = {}): Promise<Buffer> {
    const id = randomUUID();
    const inputPath = join(tmpdir(), `polloai-in-${id}.mp4`);
    const outputPath = join(tmpdir(), `polloai-out-${id}.mov`);

    await fs.writeFile(inputPath, input);

    const model = pick(IPHONE_MODELS);
    const software = pick(IOS_VERSIONS);
    const created = opts.creationDate ?? new Date();
    const creationDate = formatQuickTimeDate(created);

    const args: string[] = [
      "-y",
      "-i",
      inputPath,
      "-c",
      "copy",
      "-movflags",
      "use_metadata_tags+faststart",
      "-metadata",
      "make=Apple",
      "-metadata",
      `model=${model}`,
      "-metadata",
      `software=${software}`,
      "-metadata",
      `creation_time=${created.toISOString()}`,
      "-metadata",
      "com.apple.quicktime.make=Apple",
      "-metadata",
      `com.apple.quicktime.model=${model}`,
      "-metadata",
      `com.apple.quicktime.software=${software}`,
      "-metadata",
      `com.apple.quicktime.creationdate=${creationDate}`,
      "-f",
      "mov",
      outputPath,
    ];

    try {
      await this.runFfmpeg(args);
      return await fs.readFile(outputPath);
    } finally {
      await Promise.all([
        fs.unlink(inputPath).catch(() => undefined),
        fs.unlink(outputPath).catch(() => undefined),
      ]);
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ffmpegPath) {
        reject(new Error("ffmpeg binary unavailable"));
        return;
      }
      const proc = spawn(this.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 8 * 1024) stderr = stderr.slice(-8 * 1024);
      });
      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      });
    });
  }
}
