-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN     "mediaId" TEXT;

-- CreateIndex
CREATE INDEX "DmLog_automationId_commenterId_mediaId_idx" ON "DmLog"("automationId", "commenterId", "mediaId");
