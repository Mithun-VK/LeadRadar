/**
 * POST /api/leads/import — import leads from CSV.
 *
 * Imported leads enter the system explicitly marked as imported: no Place ID, no
 * verified website, no analysis, no score. They are not laundered into looking
 * like pipeline output, because an operator must be able to tell which leads
 * LeadRadar verified and which ones they pasted in.
 */
import { z } from 'zod';

import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { dedupeRows, parseLeadCsv, type ImportSummary } from '@/modules/leads/import';
import { normalizeBusinessName, phoneDigits, toE164 } from '@/modules/leads/normalize';

const bodySchema = z
  .object({
    /** Raw file contents. Bounded so a huge paste cannot exhaust memory. */
    csv: z
      .string()
      .min(1)
      .max(5 * 1024 * 1024),
    projectId: z.string().min(1).nullable().optional(),
    /**
     * Update fields on leads that already exist. Off by default: an import
     * overwriting verified pipeline data with whatever was in a spreadsheet is
     * a silent downgrade of data quality.
     */
    updateExisting: z.boolean().optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body, logger }): Promise<ImportSummary> => {
    const parsed = parseLeadCsv(body.csv);
    const { unique, duplicates } = dedupeRows(parsed.rows);

    let created = 0;
    let updated = 0;
    let skippedExisting = 0;

    for (const row of unique) {
      const normalizedName = normalizeBusinessName(row.businessName);
      const digits = phoneDigits(row.phone);

      /**
       * Match against existing leads on the strongest identifier available.
       *
       * Domain first, then name plus city. Deliberately NOT name alone: two
       * unrelated clinics in different cities share a name often enough that
       * merging on it would silently corrupt real leads.
       */
      const existing = await db().business.findFirst({
        where: {
          organizationId: tenant.organizationId,
          ...(row.website
            ? { verifiedDomain: row.website }
            : { normalizedName, city: row.city ?? undefined }),
        },
        select: { id: true, primaryEmail: true },
      });

      if (existing) {
        if (!body.updateExisting) {
          skippedExisting += 1;
          continue;
        }

        await db().business.update({
          where: { id: existing.id },
          data: {
            ...(row.phone && { phone: toE164(row.phone), phoneDigits: digits }),
            ...(row.industry && { primaryCategory: row.industry }),
            ...(row.city && { city: row.city }),
            ...(row.state && { state: row.state }),
            ...(row.country && { country: row.country }),
            ...(row.address && { formattedAddress: row.address }),
            // Only fill an empty email; never overwrite one the pipeline verified
            // as published on the business's own site with a spreadsheet value.
            ...(row.email && !existing.primaryEmail && { primaryEmail: row.email }),
          },
        });

        if (row.email && !existing.primaryEmail) {
          await db().emailCandidate.upsert({
            where: { businessId_email: { businessId: existing.id, email: row.email } },
            update: {},
            create: {
              businessId: existing.id,
              email: row.email,
              domain: row.email.slice(row.email.lastIndexOf('@') + 1),
              source: 'MANUAL_IMPORT',
              // Middling confidence: the operator supplied it, so it is neither
              // verified by us nor arbitrary.
              confidence: 0.6,
              isRoleAccount: false,
              matchesVerifiedDomain: false,
            },
          });
        }

        updated += 1;
        continue;
      }

      /**
       * An imported lead needs a PlaceIdentifier row because Business requires
       * one. A synthetic, namespaced id is used rather than a fabricated Google
       * Place ID, so nothing downstream can mistake it for a real one and try to
       * refresh it against the Places API.
       */
      const syntheticPlaceId = `import:${tenant.organizationId}:${normalizedName}:${row.city ?? ''}:${row.website ?? digits ?? ''}`;

      const place = await db().placeIdentifier.upsert({
        where: { googlePlaceId: syntheticPlaceId },
        update: {},
        create: { googlePlaceId: syntheticPlaceId },
        select: { id: true },
      });

      const business = await db().business.create({
        data: {
          organizationId: tenant.organizationId,
          projectId: body.projectId ?? null,
          placeIdentifierId: place.id,
          normalizedName,
          displayName: row.businessName,
          primaryCategory: row.industry,
          categories: [],
          formattedAddress: row.address,
          city: row.city,
          state: row.state,
          country: row.country,
          phone: toE164(row.phone),
          phoneDigits: digits,
          primaryEmail: row.email,
          // No claim is made about the website until the pipeline checks it.
          googleWebsiteStatus: row.website ? 'GOOGLE_WEBSITE_PRESENT' : 'GOOGLE_WEBSITE_NOT_LISTED',
          independentWebsiteStatus: 'NOT_CHECKED',
          identityVerification: 'UNVERIFIED',
        },
        select: { id: true },
      });

      if (row.email) {
        await db().emailCandidate.create({
          data: {
            businessId: business.id,
            email: row.email,
            domain: row.email.slice(row.email.lastIndexOf('@') + 1),
            source: 'MANUAL_IMPORT',
            confidence: 0.6,
            isRoleAccount: false,
            matchesVerifiedDomain: false,
          },
        });
      }

      if (row.website) {
        await db().websiteCandidate.create({
          data: {
            businessId: business.id,
            url: `https://${row.website}`,
            domain: row.website,
            source: 'MANUAL',
            status: 'PENDING',
          },
        });
      }

      created += 1;
    }

    logger.info({ created, updated, duplicates, skippedExisting }, 'CSV import finished');

    return {
      total: parsed.rows.length,
      created,
      updated,
      duplicates: duplicates + skippedExisting,
      invalid: parsed.errors.length,
      // Capped: a file with 4,000 bad rows should not return 4,000 error objects.
      errors: parsed.errors.slice(0, 100),
      mapping: parsed.mapping,
      unmappedHeaders: parsed.unmappedHeaders,
    };
  },
  {
    bodySchema,
    auditAction: 'leads.import',
    rateLimit: { capacity: 5, refillPerSecond: 0.05 },
  },
);
