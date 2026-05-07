import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Browser, chromium } from "playwright";
import { EnvService } from "./env.service";

/**
 * Playwright Chromium 池：单 Browser + 受控并发 Context。
 * 池大小、代理、headless 全部从 EnvService 读取（启动时确定，不再热更新）。
 */
@Injectable()
export class BrowserPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserPoolService.name);
  private browser: Browser | null = null;
  private inFlight = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly env: EnvService) {}

  async onModuleInit() {
    const proxy = this.env.scraperProxy ? { server: this.env.scraperProxy } : undefined;
    this.browser = await chromium.launch({
      headless: this.env.scraperHeadless,
      proxy,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });
    this.logger.log(
      `Browser launched (poolSize=${this.poolSize}${proxy ? `, proxy=${proxy.server}` : ""})`,
    );
  }

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.logger.log("Browser closed");
    }
  }

  async acquire(): Promise<void> {
    if (this.inFlight < this.poolSize) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight++;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiting.shift();
    if (next) next();
  }

  getBrowser(): Browser {
    if (!this.browser) throw new Error("Browser not initialized");
    return this.browser;
  }

  get activeBrowsers(): number {
    return this.inFlight;
  }

  get poolSize(): number {
    return this.env.scraperPoolSize;
  }
}
