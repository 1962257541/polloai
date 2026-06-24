import { Module } from "@nestjs/common";
import { EnvService } from "./services/env.service";
import { PrismaService } from "./services/prisma.service";
import { StorageService } from "./services/storage.service";
import { GeminiService } from "./services/gemini.service";
import { ApimartService } from "./services/apimart.service";
import { DoubaoService } from "./services/doubao.service";
import { VolcEngineService } from "./services/volcengine.service";
import { GenerationWorkerService } from "./services/generation-worker.service";

@Module({
  providers: [
    EnvService,
    PrismaService,
    StorageService,
    GeminiService,
    ApimartService,
    DoubaoService,
    VolcEngineService,
    GenerationWorkerService,
  ],
})
export class WorkerModule {}
