-- Map obsolete TikTok status values and replace the enum with the current app values.

UPDATE "TiktokAccount"
SET "status" = 'rate_limited'
WHERE "status" = 'captcha_blocked';

UPDATE "TiktokAccount"
SET "status" = 'error'
WHERE "status" = 'cookie_expired';

ALTER TABLE "TiktokAccount" ALTER COLUMN "status" DROP DEFAULT;

CREATE TYPE "TiktokAccountStatus_new" AS ENUM (
  'active',
  'not_found',
  'rate_limited',
  'error',
  'disabled'
);

ALTER TABLE "TiktokAccount"
  ALTER COLUMN "status" TYPE "TiktokAccountStatus_new"
  USING "status"::text::"TiktokAccountStatus_new";

DROP TYPE "TiktokAccountStatus";
ALTER TYPE "TiktokAccountStatus_new" RENAME TO "TiktokAccountStatus";

ALTER TABLE "TiktokAccount" ALTER COLUMN "status" SET DEFAULT 'active';
