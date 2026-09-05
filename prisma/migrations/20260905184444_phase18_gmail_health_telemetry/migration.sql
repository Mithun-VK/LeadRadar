-- AlterTable
ALTER TABLE "gmail_accounts" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inboxCursor" TIMESTAMP(3),
ADD COLUMN     "lastAuthAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "lastErrorDetail" TEXT,
ADD COLUMN     "lastSendAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncAt" TIMESTAMP(3);

