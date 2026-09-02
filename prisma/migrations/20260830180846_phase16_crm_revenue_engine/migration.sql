-- CreateEnum
CREATE TYPE "LeadSourceDb" AS ENUM ('WEB_DISCOVERY', 'DIRECTORY', 'CSV_IMPORT', 'MANUAL', 'REFERRAL', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "LeadStatusDb" AS ENUM ('NEW', 'QUALIFIED', 'CONTACTED', 'REPLIED', 'SQL', 'MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "StatusChangeSourceDb" AS ENUM ('SYSTEM', 'USER', 'EMAIL', 'AI', 'IMPORT');

-- CreateEnum
CREATE TYPE "ActivityTypeDb" AS ENUM ('EMAIL', 'CALL', 'MEETING', 'NOTE', 'FOLLOW_UP', 'PROPOSAL', 'TASK');

-- CreateEnum
CREATE TYPE "ActivityStatusDb" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DealStageDb" AS ENUM ('QUALIFICATION', 'DISCOVERY', 'MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "MeetingStatusDb" AS ENUM ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "ProposalStatusDb" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EmailDirectionDb" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "EmailIntentDb" AS ENUM ('POSITIVE_INTEREST', 'MEETING_REQUEST', 'PRICE_REQUEST', 'QUESTION', 'FOLLOW_UP', 'NOT_INTERESTED', 'UNSUBSCRIBE', 'OUT_OF_OFFICE', 'BOUNCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IntentSourceDb" AS ENUM ('DETERMINISTIC', 'AI');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "emailInvalid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "firstTouchAt" TIMESTAMP(3),
ADD COLUMN     "lastReplyAt" TIMESTAMP(3),
ADD COLUMN     "lastTouchAt" TIMESTAMP(3),
ADD COLUMN     "leadStatus" "LeadStatusDb" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "source" "LeadSourceDb" NOT NULL DEFAULT 'WEB_DISCOVERY',
ADD COLUMN     "sourceCampaignId" TEXT,
ADD COLUMN     "sourceUrl" TEXT;

-- CreateTable
CREATE TABLE "lead_status_history" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fromStatus" "LeadStatusDb",
    "toStatus" "LeadStatusDb" NOT NULL,
    "reason" TEXT,
    "source" "StatusChangeSourceDb" NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_activities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dealId" TEXT,
    "type" "ActivityTypeDb" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ActivityStatusDb" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBySystem" BOOLEAN NOT NULL DEFAULT false,
    "assignedToUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "DealStageDb" NOT NULL DEFAULT 'QUALIFICATION',
    "valueMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "probability" INTEGER NOT NULL DEFAULT 10,
    "expectedCloseDate" TIMESTAMP(3),
    "notes" TEXT,
    "ownerUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "sourceCampaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_stage_history" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromStage" "DealStageDb",
    "toStage" "DealStageDb" NOT NULL,
    "reason" TEXT,
    "source" "StatusChangeSourceDb" NOT NULL,
    "valueMinorAtChange" INTEGER,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_offerings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "opportunity" "ServiceOpportunityDb",
    "basePriceMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dealId" TEXT,
    "title" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "meetingUrl" TEXT,
    "status" "MeetingStatusDb" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "externalEventId" TEXT,
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dealId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amountMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "ProposalStatusDb" NOT NULL DEFAULT 'DRAFT',
    "scope" JSONB,
    "timeline" TEXT,
    "terms" TEXT,
    "notes" TEXT,
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_conversations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT,
    "campaignId" TEXT,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "direction" "EmailDirectionDb" NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "bodyExpiresAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inReplyToMessageId" TEXT,

    CONSTRAINT "email_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_intents" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "intent" "EmailIntentDb" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" "IntentSourceDb" NOT NULL,
    "reason" TEXT,
    "model" TEXT,
    "actedOn" BOOLEAN NOT NULL DEFAULT false,
    "classifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_steps" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "delayDays" INTEGER NOT NULL DEFAULT 3,
    "templateId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_status_history_businessId_createdAt_idx" ON "lead_status_history"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_status_history_toStatus_createdAt_idx" ON "lead_status_history"("toStatus", "createdAt");

-- CreateIndex
CREATE INDEX "sales_activities_organizationId_status_dueAt_idx" ON "sales_activities"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "sales_activities_businessId_createdAt_idx" ON "sales_activities"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "sales_activities_dealId_idx" ON "sales_activities"("dealId");

-- CreateIndex
CREATE INDEX "deals_organizationId_stage_idx" ON "deals"("organizationId", "stage");

-- CreateIndex
CREATE INDEX "deals_organizationId_closedAt_idx" ON "deals"("organizationId", "closedAt");

-- CreateIndex
CREATE INDEX "deals_businessId_idx" ON "deals"("businessId");

-- CreateIndex
CREATE INDEX "deals_sourceCampaignId_idx" ON "deals"("sourceCampaignId");

-- CreateIndex
CREATE INDEX "deal_stage_history_dealId_createdAt_idx" ON "deal_stage_history"("dealId", "createdAt");

-- CreateIndex
CREATE INDEX "service_offerings_organizationId_active_priority_idx" ON "service_offerings"("organizationId", "active", "priority" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "service_offerings_organizationId_name_key" ON "service_offerings"("organizationId", "name");

-- CreateIndex
CREATE INDEX "meetings_organizationId_scheduledAt_idx" ON "meetings"("organizationId", "scheduledAt");

-- CreateIndex
CREATE INDEX "meetings_organizationId_status_idx" ON "meetings"("organizationId", "status");

-- CreateIndex
CREATE INDEX "meetings_businessId_idx" ON "meetings"("businessId");

-- CreateIndex
CREATE INDEX "proposals_organizationId_status_idx" ON "proposals"("organizationId", "status");

-- CreateIndex
CREATE INDEX "proposals_businessId_idx" ON "proposals"("businessId");

-- CreateIndex
CREATE INDEX "proposals_dealId_idx" ON "proposals"("dealId");

-- CreateIndex
CREATE INDEX "email_conversations_organizationId_receivedAt_idx" ON "email_conversations"("organizationId", "receivedAt");

-- CreateIndex
CREATE INDEX "email_conversations_businessId_receivedAt_idx" ON "email_conversations"("businessId", "receivedAt");

-- CreateIndex
CREATE INDEX "email_conversations_threadId_idx" ON "email_conversations"("threadId");

-- CreateIndex
CREATE INDEX "email_conversations_bodyExpiresAt_idx" ON "email_conversations"("bodyExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_conversations_organizationId_messageId_key" ON "email_conversations"("organizationId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_intents_conversationId_key" ON "email_intents"("conversationId");

-- CreateIndex
CREATE INDEX "email_intents_intent_classifiedAt_idx" ON "email_intents"("intent", "classifiedAt");

-- CreateIndex
CREATE INDEX "campaign_steps_campaignId_active_idx" ON "campaign_steps"("campaignId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_steps_campaignId_stepNumber_key" ON "campaign_steps"("campaignId", "stepNumber");

-- CreateIndex
CREATE INDEX "businesses_organizationId_leadStatus_idx" ON "businesses"("organizationId", "leadStatus");

-- CreateIndex
CREATE INDEX "businesses_organizationId_source_idx" ON "businesses"("organizationId", "source");

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_sourceCampaignId_fkey" FOREIGN KEY ("sourceCampaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_conversations" ADD CONSTRAINT "email_conversations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_conversations" ADD CONSTRAINT "email_conversations_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_conversations" ADD CONSTRAINT "email_conversations_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_intents" ADD CONSTRAINT "email_intents_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "email_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
