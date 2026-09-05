-- AlterTable
ALTER TABLE "campaign_leads" ADD COLUMN     "currentStepNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextStepAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "campaignStepId" TEXT;

-- CreateIndex
CREATE INDEX "campaign_leads_status_nextStepAt_idx" ON "campaign_leads"("status", "nextStepAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_campaignId_businessId_campaignStepId_key" ON "email_messages"("campaignId", "businessId", "campaignStepId");

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaignStepId_fkey" FOREIGN KEY ("campaignStepId") REFERENCES "campaign_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

