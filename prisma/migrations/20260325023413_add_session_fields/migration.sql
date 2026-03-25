-- CreateEnum
CREATE TYPE "MaterialSource" AS ENUM ('uploaded', 'generated');

-- AlterTable
ALTER TABLE "GenerationTask" ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "sessionTitle" TEXT;

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL DEFAULT 'image',
    "source" "MaterialSource" NOT NULL,
    "taskId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Material_userId_createdAt_idx" ON "Material"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Material_userId_expiresAt_idx" ON "Material"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "GenerationTask_userId_sessionId_idx" ON "GenerationTask"("userId", "sessionId");

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
