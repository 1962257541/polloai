ALTER TABLE "User"
ADD COLUMN "apiUrl" TEXT,
ADD COLUMN "imageModel" TEXT,
ADD COLUMN "imageApiType" TEXT DEFAULT 'openai-images',
ADD COLUMN "videoModel" TEXT;
