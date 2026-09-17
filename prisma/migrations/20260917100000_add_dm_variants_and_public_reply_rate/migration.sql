-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "dmMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "publicReplyRatePercent" INTEGER NOT NULL DEFAULT 100;
