import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ScraperModule } from "./scraper.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(ScraperModule);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Scraper started");
}

bootstrap();
