-- Align the original TikTok monitor tables with the public profile scraper schema.

ALTER TYPE "TiktokAccountStatus" ADD VALUE IF NOT EXISTS 'not_found';
ALTER TYPE "TiktokAccountStatus" ADD VALUE IF NOT EXISTS 'rate_limited';

ALTER TABLE "TiktokAccount"
  ALTER COLUMN "handle" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "uid" TEXT,
  ADD COLUMN IF NOT EXISTS "secUid" TEXT,
  ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "bioSignature" TEXT,
  ADD COLUMN IF NOT EXISTS "salesTag" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "region" TEXT,
  ADD COLUMN IF NOT EXISTS "note" TEXT,
  ADD COLUMN IF NOT EXISTS "followingCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "heartCount" BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "TiktokAccount_uid_key" ON "TiktokAccount"("uid");

ALTER TABLE "TiktokVideo"
  ADD COLUMN IF NOT EXISTS "videoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER NOT NULL DEFAULT 0;
