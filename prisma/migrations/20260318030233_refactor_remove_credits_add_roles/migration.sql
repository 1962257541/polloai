-- CreateEnum
CREATE TYPE "GenerationType" AS ENUM ('text_to_image', 'image_to_video');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AssetRole" AS ENUM ('input', 'output');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('image', 'video');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'salesperson');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'salesperson',
    "apiKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "GenerationType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL DEFAULT 'gemini',
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "parameters" JSONB NOT NULL,
    "providerJobId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "GenerationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationAsset" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "role" "AssetRole" NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiAuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "GenerationTask_userId_createdAt_idx" ON "GenerationTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationTask_status_createdAt_idx" ON "GenerationTask"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationAsset_taskId_role_idx" ON "GenerationAsset"("taskId", "role");

-- CreateIndex
CREATE INDEX "ApiAuditLog_path_createdAt_idx" ON "ApiAuditLog"("path", "createdAt");

-- CreateIndex
CREATE INDEX "ApiAuditLog_userId_createdAt_idx" ON "ApiAuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "GenerationTask" ADD CONSTRAINT "GenerationTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationAsset" ADD CONSTRAINT "GenerationAsset_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GenerationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiAuditLog" ADD CONSTRAINT "ApiAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
