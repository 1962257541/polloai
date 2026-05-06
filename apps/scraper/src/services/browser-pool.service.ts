import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Browser, chromium } from "playwright";

interface PooledContext {
  id: number;
  active: boolean;
}

/**
 * Playwright Chromium 浏览器池。
 * M3 阶段：单 Browser + 受控并发 Context。
 * 每个抓取任务独立创建/销毁 Context（因 storageState 每个账号不同）。
 */
@Injectable()
export class BrowserPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserPoolService.name);
  private browser: Browser | null = null;
  private semaphore: number;
  private waiting: Array<() => void> = [];

  constructor() {
    this.semaphore = Number(process.env.TIKTOK_BROWSER_POOL_SIZE) || 4;
  }

  async onModuleInit() {
    this.browser = await chromium.launch({
      headless: process.env.TIKTOK_SCRAPER_HEADLESS !== "false",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });
    this.logger.log(`Browser launched (pool=${this.semaphore})`);
  }

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.logger.log("Browser closed");
    }
  }

  /** 获取一个空闲槽位 */
  async acquire(): Promise<void> {
    if (this.semaphore > 0) {
      this.semaphore--;
      return;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      next?.();
    } else {
      this.semaphore++;
    }
  }

  getBrowser(): Browser {
    if (!this.browser) throw new Error("Browser not initialized");
    return this.browser;
  }

  get activeSlots(): number {
    const max = Number(process.env.TIKTOK_BROWSER_POOL_SIZE) || 4;
    return max - this.semaphore;
  }

  get poolSize(): number {
    return Number(process.env.TIKTOK_BROWSER_POOL_SIZE) || 4;
  }
}
