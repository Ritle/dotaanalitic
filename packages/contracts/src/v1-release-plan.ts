import { z } from 'zod';
const Time = z.iso.datetime({ precision: 3 });
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const Text = z.string().min(1).max(512);
const SourceUrl = z.url().refine(v => new URL(v).protocol === 'https:');
export const V1ReleasePlanRequestSchema = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal('conditional-elo-tier1-release-v1'),
  evaluationBasis: z.literal('future_window_conditional_lineups'),
  warmupFromAt: Time, snapshotAt: Time, maxInventoryMaps: z.literal(5000),
  catalogueSha256: Sha, developmentDatasetSha256: Sha,
  events: z.array(z.object({
    eventKey: z.string().regex(/^[a-z0-9-]{3,100}$/), name: Text,
    provider: z.literal('opendota'), leagueId: Id, catalogueName: Text,
    stage: z.literal('main_event'), fromAt: Time, until: Time,
    tierDecision: z.object({ basis: z.literal('reviewed_event_scope'), sourceUrl: SourceUrl,
      reviewedAt: Time, rationale: z.string().min(20).max(2000) }).strict(),
    scheduleSourceUrl: SourceUrl
  }).strict()).min(1).max(5)
}).strict().refine(r => new Set(r.events.map(e => e.eventKey)).size === r.events.length &&
  new Set(r.events.map(e => e.leagueId)).size === r.events.length &&
  r.events.every(e => r.warmupFromAt < e.fromAt && e.fromAt < e.until && e.until < r.snapshotAt),
{ message: 'invalid_release_scope_or_windows' });

// Catalogue is metadata, never a test outcome source or an automatic Tier 1 classifier.
export const V1ReleaseCatalogueCaptureSchema = z.object({
  source: z.object({ provider: z.literal('opendota'), endpoint: z.literal('/leagues'),
    fetchedAt: Time, knownAt: z.null(), payloadSha256: Sha }),
  rawBody: z.string().min(2).max(8388608)
}).strict();
export const V1ReleaseCatalogueRowsSchema = z.array(z.object({
  leagueid: z.union([Id, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]),
  name: Text.nullish(), tier: z.string().nullish()
})).max(20000);
export type V1ReleasePlanRequest = z.infer<typeof V1ReleasePlanRequestSchema>;
