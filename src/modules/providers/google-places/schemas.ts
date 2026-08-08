/**
 * Google Places response schemas.
 *
 * Provider responses are validated, not trusted. Almost every field is optional
 * because Places genuinely omits them: a business with no reviews has no
 * `rating`, a service-area business has no `location`, and many listings have no
 * `websiteUri` — which is the entire premise of the product. Treating any of
 * these as required would fail a job on ordinary data.
 *
 * Unknown keys are allowed through (not `.strict()`): Google adds fields
 * routinely, and rejecting a response because it gained a field would be a
 * self-inflicted outage. The normalizer reads only what it knows.
 */
import { z } from 'zod';

const localizedText = z.object({
  text: z.string(),
  languageCode: z.string().optional(),
});

const addressComponent = z.object({
  longText: z.string().optional(),
  shortText: z.string().optional(),
  types: z.array(z.string()).default([]),
});

const latLng = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export const placeSchema = z.object({
  /** Resource name, e.g. 'places/ChIJ...'. */
  name: z.string().optional(),
  id: z.string().min(1),
  displayName: localizedText.optional(),
  formattedAddress: z.string().optional(),
  addressComponents: z.array(addressComponent).optional(),
  location: latLng.optional(),
  types: z.array(z.string()).optional(),
  primaryType: z.string().optional(),
  businessStatus: z.string().optional(),
  googleMapsUri: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().int().optional(),
  websiteUri: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
});

export type GooglePlace = z.infer<typeof placeSchema>;

export const textSearchResponseSchema = z.object({
  // Absent rather than empty when nothing matches.
  places: z.array(placeSchema).optional(),
  nextPageToken: z.string().optional(),
});

export type TextSearchResponse = z.infer<typeof textSearchResponseSchema>;

export const placeDetailsResponseSchema = placeSchema;

/** Google's error envelope, used to map upstream failures onto our taxonomy. */
export const googleErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  }),
});

export type GoogleErrorBody = z.infer<typeof googleErrorSchema>;
