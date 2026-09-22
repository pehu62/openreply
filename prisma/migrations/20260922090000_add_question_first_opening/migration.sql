-- Question-first opening DM: ask which list, send the link once the person answers.
ALTER TABLE "Automation" ADD COLUMN "openingDmAwaitsReply" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Automation" ADD COLUMN "openingDmMessages" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- The link owed to someone who was asked a question and has not answered yet.
ALTER TABLE "DmLog" ADD COLUMN "awaitingReply" BOOLEAN NOT NULL DEFAULT false;

-- Looked up on every inbound DM: the pending question for this person, if any.
CREATE INDEX "DmLog_commenterId_awaitingReply_idx" ON "DmLog"("commenterId", "awaitingReply");
