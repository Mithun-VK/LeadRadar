/**
 * GET /api/leads/:id — full lead profile.
 *
 * Every field is returned under an explicit provenance label, so the UI can show
 * which facts came from Google, which LeadRadar verified itself, and which it
 * computed. Mixing those into one flat payload is how a product ends up
 * presenting an inference as a fact.
 */
import { handler } from '@/modules/api/handler';
import { getBusiness } from '@/modules/database/repositories';
import { priorityLabel } from '@/modules/scoring/config';

export const GET = handler(async ({ tenant, params }) => {
  const lead = await getBusiness(tenant, params.id ?? '');
  const score = lead.leadScores[0];

  return {
    id: lead.id,

    // --- Google-derived: attributed, held under a TTL ------------------------
    googleDerived: {
      displayName: lead.displayName,
      formattedAddress: lead.formattedAddress,
      city: lead.city,
      state: lead.state,
      country: lead.country,
      postalCode: lead.postalCode,
      phone: lead.phone,
      rating: lead.rating,
      reviewCount: lead.reviewCount,
      primaryCategory: lead.primaryCategory,
      categories: lead.categories,
      businessStatus: lead.businessStatus,
      googleWebsiteStatus: lead.googleWebsiteStatus,
      attribution: 'Powered by Google',
    },

    // --- place identifier: retained indefinitely ----------------------------
    placeIdentifier: { googlePlaceId: lead.placeIdentifier.googlePlaceId },

    // --- public web: our own crawl -----------------------------------------
    publicWeb: {
      verifiedDomain: lead.verifiedDomain,
      candidates: lead.websiteCandidates.map((candidate) => ({
        url: candidate.url,
        domain: candidate.domain,
        title: candidate.title,
        source: candidate.source,
        status: candidate.status,
        isThirdPartyListing: candidate.isThirdPartyListing,
        confidence: candidate.confidence,
      })),
      socialProfiles: lead.socialProfiles.map((profile) => ({
        platform: profile.platform,
        url: profile.url,
        username: profile.username,
        status: profile.status,
        confidence: profile.confidence,
      })),
    },

    // --- application-generated ---------------------------------------------
    intelligence: {
      independentWebsiteStatus: lead.independentWebsiteStatus,
      identityVerification: lead.identityVerification,
      digitalPresence: lead.digitalPresence,
      opportunityScore: lead.opportunityScore,
      leadPriority: lead.leadPriority,
      priorityLabel: lead.leadPriority ? priorityLabel(lead.leadPriority) : null,
      isChain: lead.isChain,
      scoreBreakdown: score
        ? {
            total: score.score,
            factors: {
              need: score.needFactor,
              value: score.valueFactor,
              reach: score.reachFactor,
            },
            signals: score.breakdown,
            appliedCaps: score.appliedCaps,
            signalsVersion: score.signalsVersion,
            computedAt: score.createdAt,
          }
        : null,
      recommendations: lead.recommendations.map((rec) => ({
        service: rec.service,
        strength: rec.strength,
        // The pitch is stored last in `reasons`; rule ids precede it.
        pitch: rec.reasons.at(-1) ?? null,
        ruleIds: rec.reasons.slice(0, -1),
      })),
      verifications: lead.verifications.map((verification) => ({
        domain: verification.candidate.domain,
        status: verification.status,
        confidence: verification.confidence,
        deterministicScore: verification.deterministicScore,
        matched: {
          name: verification.matchedName,
          phone: verification.matchedPhone,
          address: verification.matchedAddress,
          city: verification.matchedCity,
          category: verification.matchedCategory,
        },
        evidence: verification.evidence,
        usedAi: verification.usedAi,
        verifiedAt: verification.verifiedAt,
      })),
      aiAnalyses: lead.aiAnalyses.map((analysis) => ({
        taskType: analysis.taskType,
        model: analysis.model,
        result: analysis.result,
        confidence: analysis.confidence,
        evidence: analysis.evidence,
        band: analysis.band,
        createdAt: analysis.createdAt,
      })),
      enrichedAt: lead.enrichedAt,
    },

    notes: lead.notes.map((note) => ({ id: note.id, body: note.body, createdAt: note.createdAt })),
  };
});
