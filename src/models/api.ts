/**
 * Runtime-validated shapes for JSON that crosses the network boundary.
 *
 * These mirror the YouVersion Platform OpenAPI document exactly and are kept
 * deliberately separate from the domain models in `./domain.ts`. Nothing outside
 * `src/providers/` should import from this file: providers translate API models
 * into domain models so that an API change stays contained.
 *
 * Source of truth: https://developers.youversion.com/api (see docs/api-research.md).
 */
import { z } from "zod";

/** `GET /v1/highlights` — one entry per highlighted verse. Ranges are expanded server-side. */
export const ApiHighlightSchema = z.object({
  bible_id: z.number().int(),
  passage_id: z.string().min(1),
  /** Lowercase 6-digit hex, no leading `#`. */
  color: z.string().regex(/^[0-9a-f]{6}$/),
});
export type ApiHighlight = z.infer<typeof ApiHighlightSchema>;

export const ApiHighlightCollectionSchema = z.object({
  data: z.array(ApiHighlightSchema),
});
export type ApiHighlightCollection = z.infer<typeof ApiHighlightCollectionSchema>;

/** `GET /v1/bibles/{id}/index` — full book/chapter/verse hierarchy for one version. */
export const ApiBibleIndexSchema = z.object({
  text_direction: z.string().optional(),
  books: z.array(
    z.object({
      id: z.string(),
      title: z.string().optional(),
      full_title: z.string().optional(),
      abbreviation: z.string().optional(),
      canon: z.string().optional(),
      chapters: z
        .array(
          z.object({
            id: z.union([z.string(), z.number()]).optional(),
            passage_id: z.string(),
            title: z.union([z.string(), z.number()]).optional(),
          }),
        )
        .default([]),
    }),
  ),
});
export type ApiBibleIndex = z.infer<typeof ApiBibleIndexSchema>;

/** `GET /v1/bibles/{id}` — version metadata, including publisher copyright text. */
export const ApiBibleSchema = z.object({
  id: z.number().int(),
  abbreviation: z.string().optional(),
  localized_abbreviation: z.string().optional(),
  title: z.string().optional(),
  localized_title: z.string().optional(),
  language_tag: z.string().optional(),
  copyright: z.string().optional(),
  promotional_content: z.string().optional(),
  publisher_url: z.string().optional(),
  info: z.string().optional(),
});
export type ApiBible = z.infer<typeof ApiBibleSchema>;

/** `GET /v1/bibles?language_ranges[]=eng` */
export const ApiBibleListSchema = z.object({
  data: z.array(
    z.object({
      id: z.number().int(),
      abbreviation: z.string().optional(),
      localized_abbreviation: z.string().optional(),
      title: z.string().optional(),
    }),
  ),
});

/** `GET /v1/bibles/{id}/passages/{passage_id}?format=text` */
export const ApiPassageSchema = z.object({
  passage_id: z.string().optional(),
  reference: z.string().optional(),
  content: z.string().optional(),
  copyright: z.string().optional(),
});
export type ApiPassage = z.infer<typeof ApiPassageSchema>;

/** `GET /v1/apps/{app_id}/permissions` — permissions this user already granted us. */
export const ApiGrantedPermissionsSchema = z.object({
  permissions: z.array(z.string()),
});

/** `POST /auth/token` */
export const ApiTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  // The documented example returns this as a string; accept both.
  expires_in: z.union([z.number(), z.string()]).optional(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  scope: z.string().optional(),
});
export type ApiTokenResponse = z.infer<typeof ApiTokenResponseSchema>;

/** Documented error body: `{ "message": "..." }`, sometimes with `error`. */
export const ApiErrorSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});
