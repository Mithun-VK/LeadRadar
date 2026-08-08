-- CreateEnum
CREATE TYPE "BusinessStatusDb" AS ENUM ('OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "GoogleWebsiteStatusDb" AS ENUM ('GOOGLE_WEBSITE_PRESENT', 'GOOGLE_WEBSITE_NOT_LISTED', 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING');

-- CreateEnum
CREATE TYPE "IndependentWebsiteStatusDb" AS ENUM ('NOT_CHECKED', 'INDEPENDENT_WEBSITE_FOUND', 'NO_INDEPENDENT_WEBSITE_FOUND', 'WEBSITE_UNVERIFIED', 'WEBSITE_BROKEN', 'WEBSITE_MISMATCH');

-- CreateEnum
CREATE TYPE "DigitalPresenceLevelDb" AS ENUM ('EXCELLENT', 'GOOD', 'MODERATE', 'WEAK', 'MINIMAL');

-- CreateEnum
CREATE TYPE "LeadPriorityDb" AS ENUM ('A_PLUS', 'A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "VerificationLevelDb" AS ENUM ('VERIFIED', 'PROBABLE', 'UNVERIFIED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "JobStatusDb" AS ENUM ('PENDING', 'ESTIMATING', 'AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED_BUDGET', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebsiteCandidateSourceDb" AS ENUM ('GOOGLE_PLACES_FIELD', 'WEB_SEARCH_NAME_CITY', 'WEB_SEARCH_NAME_PHONE', 'WEB_SEARCH_NAME_ADDRESS', 'SOCIAL_PROFILE_LINK', 'MANUAL');

-- CreateEnum
CREATE TYPE "WebsiteCandidateStatusDb" AS ENUM ('PENDING', 'VERIFYING', 'ACCEPTED', 'REJECTED', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "WebsiteMatchStatusDb" AS ENUM ('MATCH', 'PROBABLE_MATCH', 'PROBABLE_MISMATCH', 'MISMATCH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SocialPlatformDb" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'X', 'WHATSAPP_BUSINESS');

-- CreateEnum
CREATE TYPE "SocialProfileStatusDb" AS ENUM ('DISCOVERED', 'VERIFIED', 'PROBABLE', 'REJECTED');

-- CreateEnum
CREATE TYPE "AiTaskTypeDb" AS ENUM ('QUERY_PARSE', 'CATEGORY_NORMALIZE', 'WEBSITE_MATCH', 'DIGITAL_PRESENCE_CLASSIFY', 'SERVICE_RECOMMEND', 'LEAD_NARRATIVE');

-- CreateEnum
CREATE TYPE "ServiceOpportunityDb" AS ENUM ('WEBSITE_DEVELOPMENT', 'WEBSITE_REDESIGN', 'SEO', 'LOCAL_SEO', 'SOCIAL_MEDIA_MARKETING', 'CONTENT_MARKETING', 'PAID_ADVERTISING', 'BRANDING', 'AI_AUTOMATION');

-- CreateEnum
CREATE TYPE "ExportFormatDb" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ExportStatusDb" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "place_identifiers" (
    "id" TEXT NOT NULL,
    "googlePlaceId" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_place_snapshots" (
    "id" TEXT NOT NULL,
    "placeIdentifierId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "formattedAddress" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "phone" TEXT,
    "rating" DOUBLE PRECISION,
    "reviewCount" INTEGER,
    "businessStatus" "BusinessStatusDb" NOT NULL DEFAULT 'UNKNOWN',
    "googleMapsUri" TEXT,
    "websiteUri" TEXT,
    "primaryCategory" TEXT,
    "categories" TEXT[],
    "skuKey" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_place_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "placeIdentifierId" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "primaryCategory" TEXT,
    "categories" TEXT[],
    "formattedAddress" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "phone" TEXT,
    "phoneDigits" TEXT,
    "rating" DOUBLE PRECISION,
    "reviewCount" INTEGER,
    "businessStatus" "BusinessStatusDb" NOT NULL DEFAULT 'UNKNOWN',
    "googleWebsiteStatus" "GoogleWebsiteStatusDb" NOT NULL DEFAULT 'GOOGLE_WEBSITE_NOT_LISTED',
    "independentWebsiteStatus" "IndependentWebsiteStatusDb" NOT NULL DEFAULT 'NOT_CHECKED',
    "verifiedDomain" TEXT,
    "digitalPresence" "DigitalPresenceLevelDb",
    "opportunityScore" INTEGER,
    "leadPriority" "LeadPriorityDb",
    "identityVerification" "VerificationLevelDb" NOT NULL DEFAULT 'UNVERIFIED',
    "isChain" BOOLEAN NOT NULL DEFAULT false,
    "enrichedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "createdByUserId" TEXT,
    "rawQuery" TEXT NOT NULL,
    "structuredQuery" JSONB NOT NULL,
    "status" "JobStatusDb" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "statusMessage" TEXT,
    "estimatedGoogleRequests" INTEGER NOT NULL DEFAULT 0,
    "estimatedFirecrawlCredits" INTEGER NOT NULL DEFAULT 0,
    "estimatedGroqCalls" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicros" INTEGER NOT NULL DEFAULT 0,
    "actualCostMicros" INTEGER NOT NULL DEFAULT 0,
    "discoveredCount" INTEGER NOT NULL DEFAULT 0,
    "filteredCount" INTEGER NOT NULL DEFAULT 0,
    "enrichedCount" INTEGER NOT NULL DEFAULT 0,
    "qualifiedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "search_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_results" (
    "id" TEXT NOT NULL,
    "searchJobId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "passedFilter" BOOLEAN NOT NULL DEFAULT false,
    "filterReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_cells" (
    "id" TEXT NOT NULL,
    "searchJobId" TEXT NOT NULL,
    "cellKey" TEXT NOT NULL,
    "south" DOUBLE PRECISION NOT NULL,
    "west" DOUBLE PRECISION NOT NULL,
    "north" DOUBLE PRECISION NOT NULL,
    "east" DOUBLE PRECISION NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL,
    "saturated" BOOLEAN NOT NULL DEFAULT false,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geo_cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_candidates" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "source" "WebsiteCandidateSourceDb" NOT NULL,
    "status" "WebsiteCandidateStatusDb" NOT NULL DEFAULT 'PENDING',
    "position" INTEGER,
    "confidence" DOUBLE PRECISION,
    "httpsEnabled" BOOLEAN,
    "httpStatus" INTEGER,
    "isThirdPartyListing" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_verifications" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "WebsiteMatchStatusDb" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "deterministicScore" INTEGER NOT NULL,
    "matchedName" BOOLEAN NOT NULL DEFAULT false,
    "matchedPhone" BOOLEAN NOT NULL DEFAULT false,
    "matchedAddress" BOOLEAN NOT NULL DEFAULT false,
    "matchedCity" BOOLEAN NOT NULL DEFAULT false,
    "matchedCategory" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB NOT NULL,
    "usedAi" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_profiles" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "platform" "SocialPlatformDb" NOT NULL,
    "url" TEXT NOT NULL,
    "username" TEXT,
    "status" "SocialProfileStatusDb" NOT NULL DEFAULT 'DISCOVERED',
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "taskType" "AiTaskTypeDb" NOT NULL,
    "model" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_scores" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "priority" "LeadPriorityDb" NOT NULL,
    "needFactor" DOUBLE PRECISION NOT NULL,
    "valueFactor" DOUBLE PRECISION NOT NULL,
    "reachFactor" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB NOT NULL,
    "appliedCaps" TEXT[],
    "signalsVersion" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_recommendations" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "service" "ServiceOpportunityDb" NOT NULL,
    "strength" INTEGER NOT NULL,
    "reasons" TEXT[],
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_notes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "format" "ExportFormatDb" NOT NULL,
    "status" "ExportStatusDb" NOT NULL DEFAULT 'PENDING',
    "filters" JSONB NOT NULL,
    "columns" TEXT[],
    "includesGoogleDerived" BOOLEAN NOT NULL DEFAULT false,
    "rowCount" INTEGER,
    "storagePath" TEXT,
    "byteSize" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "place_identifiers_googlePlaceId_key" ON "place_identifiers"("googlePlaceId");

-- CreateIndex
CREATE INDEX "place_identifiers_lastVerifiedAt_idx" ON "place_identifiers"("lastVerifiedAt");

-- CreateIndex
CREATE INDEX "google_place_snapshots_placeIdentifierId_fetchedAt_idx" ON "google_place_snapshots"("placeIdentifierId", "fetchedAt");

-- CreateIndex
CREATE INDEX "google_place_snapshots_expiresAt_idx" ON "google_place_snapshots"("expiresAt");

-- CreateIndex
CREATE INDEX "businesses_organizationId_opportunityScore_idx" ON "businesses"("organizationId", "opportunityScore" DESC);

-- CreateIndex
CREATE INDEX "businesses_organizationId_city_primaryCategory_idx" ON "businesses"("organizationId", "city", "primaryCategory");

-- CreateIndex
CREATE INDEX "businesses_organizationId_leadPriority_idx" ON "businesses"("organizationId", "leadPriority");

-- CreateIndex
CREATE INDEX "businesses_organizationId_enrichedAt_idx" ON "businesses"("organizationId", "enrichedAt");

-- CreateIndex
CREATE INDEX "businesses_normalizedName_idx" ON "businesses"("normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_organizationId_placeIdentifierId_key" ON "businesses"("organizationId", "placeIdentifierId");

-- CreateIndex
CREATE INDEX "search_jobs_organizationId_createdAt_idx" ON "search_jobs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "search_jobs_organizationId_status_idx" ON "search_jobs"("organizationId", "status");

-- CreateIndex
CREATE INDEX "search_results_businessId_idx" ON "search_results"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "search_results_searchJobId_businessId_key" ON "search_results"("searchJobId", "businessId");

-- CreateIndex
CREATE INDEX "geo_cells_searchJobId_completedAt_idx" ON "geo_cells"("searchJobId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "geo_cells_searchJobId_cellKey_category_key" ON "geo_cells"("searchJobId", "cellKey", "category");

-- CreateIndex
CREATE INDEX "website_candidates_businessId_status_idx" ON "website_candidates"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "website_candidates_businessId_domain_key" ON "website_candidates"("businessId", "domain");

-- CreateIndex
CREATE INDEX "website_verifications_businessId_verifiedAt_idx" ON "website_verifications"("businessId", "verifiedAt");

-- CreateIndex
CREATE INDEX "website_verifications_candidateId_idx" ON "website_verifications"("candidateId");

-- CreateIndex
CREATE INDEX "social_profiles_businessId_idx" ON "social_profiles"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "social_profiles_businessId_platform_url_key" ON "social_profiles"("businessId", "platform", "url");

-- CreateIndex
CREATE INDEX "ai_analyses_businessId_taskType_createdAt_idx" ON "ai_analyses"("businessId", "taskType", "createdAt");

-- CreateIndex
CREATE INDEX "ai_analyses_taskType_createdAt_idx" ON "ai_analyses"("taskType", "createdAt");

-- CreateIndex
CREATE INDEX "lead_scores_businessId_isCurrent_idx" ON "lead_scores"("businessId", "isCurrent");

-- CreateIndex
CREATE INDEX "lead_scores_businessId_createdAt_idx" ON "lead_scores"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "service_recommendations_businessId_isCurrent_idx" ON "service_recommendations"("businessId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "service_recommendations_businessId_service_isCurrent_key" ON "service_recommendations"("businessId", "service", "isCurrent");

-- CreateIndex
CREATE INDEX "lead_notes_organizationId_businessId_createdAt_idx" ON "lead_notes"("organizationId", "businessId", "createdAt");

-- CreateIndex
CREATE INDEX "export_jobs_organizationId_createdAt_idx" ON "export_jobs"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "google_place_snapshots" ADD CONSTRAINT "google_place_snapshots_placeIdentifierId_fkey" FOREIGN KEY ("placeIdentifierId") REFERENCES "place_identifiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_placeIdentifierId_fkey" FOREIGN KEY ("placeIdentifierId") REFERENCES "place_identifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "search_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_cells" ADD CONSTRAINT "geo_cells_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "search_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_candidates" ADD CONSTRAINT "website_candidates_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_verifications" ADD CONSTRAINT "website_verifications_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_verifications" ADD CONSTRAINT "website_verifications_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "website_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_profiles" ADD CONSTRAINT "social_profiles_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_recommendations" ADD CONSTRAINT "service_recommendations_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
