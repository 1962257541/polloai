-- CreateEnum
CREATE TYPE "TiktokAccountStatus" AS ENUM ('active', 'cookie_expired', 'captcha_blocked', 'error', 'disabled');

-- CreateTable
CREATE TABLE "SystemConfig" (
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "valuePlain" TEXT,
    "valueEnc" BYTEA,
    "valueIv" BYTEA,
    "valueTag" BYTEA,
    "byteLength" INTEGER,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TiktokAccount" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "nickname" TEXT,
    "status" "TiktokAccountStatus" NOT NULL DEFAULT 'active',
    "storageStateEnc" BYTEA,
    "storageStateIv" BYTEA,
    "storageStateTag" BYTEA,
    "scrapeIntervalMin" INTEGER NOT NULL DEFAULT 60,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "totalGmvCents" BIGINT NOT NULL DEFAULT 0,
    "totalCommissionCents" BIGINT NOT NULL DEFAULT 0,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "lastScrapedAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TiktokAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiktokVideo" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "title" TEXT,
    "coverUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "playCount" BIGINT NOT NULL DEFAULT 0,
    "likeCount" BIGINT NOT NULL DEFAULT 0,
    "commentCount" BIGINT NOT NULL DEFAULT 0,
    "shareCount" BIGINT NOT NULL DEFAULT 0,
    "collectCount" BIGINT NOT NULL DEFAULT 0,
    "gmvCents" BIGINT NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiktokVideoMetric" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "playCount" BIGINT NOT NULL,
    "likeCount" BIGINT NOT NULL,
    "commentCount" BIGINT NOT NULL,
    "shareCount" BIGINT NOT NULL,
    "collectCount" BIGINT NOT NULL,
    "gmvCents" BIGINT NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokVideoMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemConfig_category_idx" ON "SystemConfig"("category");

-- CreateIndex
CREATE UNIQUE INDEX "TiktokAccount_handle_key" ON "TiktokAccount"("handle");

-- CreateIndex
CREATE INDEX "TiktokAccount_ownerId_createdAt_idx" ON "TiktokAccount"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "TiktokAccount_status_lastScrapedAt_idx" ON "TiktokAccount"("status", "lastScrapedAt");

-- CreateIndex
CREATE INDEX "TiktokVideo_accountId_publishedAt_idx" ON "TiktokVideo"("accountId", "publishedAt");

-- CreateIndex
CREATE INDEX "TiktokVideo_accountId_playCount_idx" ON "TiktokVideo"("accountId", "playCount");

-- CreateIndex
CREATE UNIQUE INDEX "TiktokVideo_accountId_videoId_key" ON "TiktokVideo"("accountId", "videoId");

-- CreateIndex
CREATE INDEX "TiktokVideoMetric_videoId_capturedAt_idx" ON "TiktokVideoMetric"("videoId", "capturedAt");

-- AddForeignKey
ALTER TABLE "TiktokAccount" ADD CONSTRAINT "TiktokAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TiktokVideo" ADD CONSTRAINT "TiktokVideo_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TiktokAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TiktokVideoMetric" ADD CONSTRAINT "TiktokVideoMetric_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "TiktokVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
