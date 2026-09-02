-- CreateEnum
CREATE TYPE "EmailSourceDb" AS ENUM ('PAGE_MAILTO', 'PAGE_TEXT', 'CONTACT_PAGE', 'MANUAL_IMPORT');

-- CreateEnum
CREATE TYPE "CampaignStatusDb" AS ENUM ('DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignLeadStatusDb" AS ENUM ('PENDING', 'SKIPPED', 'QUEUED', 'SENT', 'FAILED', 'REPLIED', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "EmailStatusDb" AS ENUM ('DRAFT', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'BOUNCED', 'REPLIED', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "EmailEventTypeDb" AS ENUM ('QUEUED', 'SEND_ATTEMPTED', 'SENT', 'FAILED', 'BOUNCED', 'REPLIED', 'UNSUBSCRIBED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "SuppressionReasonDb" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'MANUAL', 'INVALID');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "opportunityFlags" TEXT[],
ADD COLUMN     "primaryEmail" TEXT,
ADD COLUMN     "websiteQualityScore" INTEGER;

-- CreateTable
CREATE TABLE "email_candidates" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "source" "EmailSourceDb" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "isRoleAccount" BOOLEAN NOT NULL DEFAULT false,
    "matchesVerifiedDomain" BOOLEAN NOT NULL DEFAULT false,
    "foundOnUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_analyses" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "qualityScore" INTEGER NOT NULL,
    "seoScore" INTEGER NOT NULL,
    "mobileScore" INTEGER NOT NULL,
    "securityScore" INTEGER NOT NULL,
    "contentScore" INTEGER NOT NULL,
    "trustScore" INTEGER NOT NULL,
    "performanceScore" INTEGER,
    "performanceNote" TEXT,
    "httpsEnabled" BOOLEAN NOT NULL,
    "hasViewportMeta" BOOLEAN NOT NULL,
    "hasTitle" BOOLEAN NOT NULL,
    "titleLength" INTEGER,
    "hasMetaDescription" BOOLEAN NOT NULL,
    "metaDescriptionLength" INTEGER,
    "h1Count" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "imagesWithAlt" INTEGER NOT NULL DEFAULT 0,
    "hasStructuredData" BOOLEAN NOT NULL DEFAULT false,
    "hasCanonical" BOOLEAN NOT NULL DEFAULT false,
    "hasContactPage" BOOLEAN NOT NULL DEFAULT false,
    "hasBookingIndicator" BOOLEAN NOT NULL DEFAULT false,
    "hasResponsiveHints" BOOLEAN NOT NULL DEFAULT false,
    "internalLinkCount" INTEGER NOT NULL DEFAULT 0,
    "externalLinkCount" INTEGER NOT NULL DEFAULT 0,
    "contentLength" INTEGER NOT NULL DEFAULT 0,
    "mixedContentCount" INTEGER NOT NULL DEFAULT 0,
    "isThin" BOOLEAN NOT NULL DEFAULT false,
    "isParked" BOOLEAN NOT NULL DEFAULT false,
    "isFreeHosting" BOOLEAN NOT NULL DEFAULT false,
    "findings" JSONB NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "refreshTokenCipher" TEXT NOT NULL,
    "accessTokenCipher" TEXT,
    "accessTokenExpiry" TIMESTAMP(3),
    "grantedScopes" TEXT[],
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedCode" TEXT,
    "sentCountDate" TIMESTAMP(3),
    "sentCountToday" INTEGER NOT NULL DEFAULT 0,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gmail_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "variables" TEXT[],
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "templateId" TEXT,
    "gmailAccountId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatusDb" NOT NULL DEFAULT 'DRAFT',
    "senderName" TEXT,
    "companyName" TEXT,
    "dailyLimit" INTEGER NOT NULL DEFAULT 50,
    "delaySeconds" INTEGER NOT NULL DEFAULT 120,
    "useAiPersonalization" BOOLEAN NOT NULL DEFAULT false,
    "sentCountDate" TIMESTAMP(3),
    "sentCountToday" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "activatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_leads" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" "CampaignLeadStatusDb" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "resolvedEmail" TEXT,
    "previewSubject" TEXT,
    "previewBody" TEXT,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "campaign_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT,
    "businessId" TEXT,
    "gmailAccountId" TEXT,
    "toEmail" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatusDb" NOT NULL DEFAULT 'DRAFT',
    "providerMessageId" TEXT,
    "providerThreadId" TEXT,
    "messageIdHeader" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "errorCode" TEXT,
    "mocked" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribeToken" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_events" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "EmailEventTypeDb" NOT NULL,
    "detail" TEXT,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "reason" "SuppressionReasonDb" NOT NULL,
    "detail" TEXT,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_candidates_businessId_confidence_idx" ON "email_candidates"("businessId", "confidence" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "email_candidates_businessId_email_key" ON "email_candidates"("businessId", "email");

-- CreateIndex
CREATE INDEX "website_analyses_businessId_isCurrent_idx" ON "website_analyses"("businessId", "isCurrent");

-- CreateIndex
CREATE INDEX "website_analyses_businessId_analyzedAt_idx" ON "website_analyses"("businessId", "analyzedAt");

-- CreateIndex
CREATE INDEX "gmail_accounts_organizationId_idx" ON "gmail_accounts"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "gmail_accounts_organizationId_emailAddress_key" ON "gmail_accounts"("organizationId", "emailAddress");

-- CreateIndex
CREATE INDEX "email_templates_organizationId_isArchived_idx" ON "email_templates"("organizationId", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_organizationId_name_key" ON "email_templates"("organizationId", "name");

-- CreateIndex
CREATE INDEX "campaigns_organizationId_status_idx" ON "campaigns"("organizationId", "status");

-- CreateIndex
CREATE INDEX "campaigns_organizationId_createdAt_idx" ON "campaigns"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organizationId_name_key" ON "campaigns"("organizationId", "name");

-- CreateIndex
CREATE INDEX "campaign_leads_campaignId_status_idx" ON "campaign_leads"("campaignId", "status");

-- CreateIndex
CREATE INDEX "campaign_leads_businessId_idx" ON "campaign_leads"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_leads_campaignId_businessId_key" ON "campaign_leads"("campaignId", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_unsubscribeToken_key" ON "email_messages"("unsubscribeToken");

-- CreateIndex
CREATE INDEX "email_messages_organizationId_status_createdAt_idx" ON "email_messages"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "email_messages_campaignId_status_idx" ON "email_messages"("campaignId", "status");

-- CreateIndex
CREATE INDEX "email_messages_businessId_idx" ON "email_messages"("businessId");

-- CreateIndex
CREATE INDEX "email_events_messageId_createdAt_idx" ON "email_events"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "suppression_entries_organizationId_createdAt_idx" ON "suppression_entries"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_entries_organizationId_emailHash_key" ON "suppression_entries"("organizationId", "emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "org_settings_organizationId_key_key" ON "org_settings"("organizationId", "key");

-- CreateIndex
CREATE INDEX "businesses_organizationId_websiteQualityScore_idx" ON "businesses"("organizationId", "websiteQualityScore");

-- AddForeignKey
ALTER TABLE "email_candidates" ADD CONSTRAINT "email_candidates_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_analyses" ADD CONSTRAINT "website_analyses_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gmail_accounts" ADD CONSTRAINT "gmail_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "gmail_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "gmail_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
