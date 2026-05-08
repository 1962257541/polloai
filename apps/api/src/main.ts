import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { EnvService } from "./config/env.service";
import { RequestIdMiddleware } from "./common/request-id.middleware";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const env = app.get(EnvService);

  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        return callback(null, true);
      }
      const allowList = env.corsOrigins;
      if (allowList.includes("*") || allowList.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-request-id"],
    exposedHeaders: ["x-request-id", "Content-Disposition"],
    credentials: false,
    optionsSuccessStatus: 204,
  });

  app.use(RequestIdMiddleware);
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(env.appPort);
  console.log(`API started at http://localhost:${env.appPort}/api/v1`);
}

bootstrap();
