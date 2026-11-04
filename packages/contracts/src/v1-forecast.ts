import { z } from 'zod';
import { CatalogIdSchema } from './catalog.js';
const Https = z.url().refine(v => new URL(v).protocol === 'https:');
/** Explicit map selector; a series without map number is deliberately not a target. */
export const V1RealTargetSchema = z.object({ provider: z.literal('opendota'), providerSeriesId: CatalogIdSchema,
  mapNumber: z.literal(1), sourceUrl: Https, rationale: z.string().trim().min(20).max(2000) }).strict();
/** Versioned reference to an owner-reviewed meeting; never an OpenDota series ID. */
export const V1ScheduledRealTargetSchema = z.object({provider:z.literal('pandascore'),bindingVersion:z.literal(1),
  providerMatchId:CatalogIdSchema,mapNumber:z.literal(1),targetRequestId:z.uuid().transform(v=>v.toLowerCase()),
  targetSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const V1AnyRealTargetSchema=z.union([V1RealTargetSchema,V1ScheduledRealTargetSchema]);
export type V1ScheduledRealTarget=z.infer<typeof V1ScheduledRealTargetSchema>;
export const V1OutcomeRefreshSchema = z.object({ requestId: z.uuid(), predictionRequestId: z.uuid(), matchId: CatalogIdSchema,
  expectedRevision: z.number().int().nonnegative().max(2147483646) }).strict();
export type V1RealTarget = z.infer<typeof V1RealTargetSchema>;
const Time = z.iso.datetime({ precision: 3 }), Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const V1ScheduleResultProofSchema=z.object({requestId:z.uuid(),sha256:Sha,targetRequestId:z.uuid(),targetSha256:Sha,
  providerMatchId:CatalogIdSchema,providerSeriesId:CatalogIdSchema,matchId:CatalogIdSchema,
  reviewedAt:z.iso.datetime({precision:6}),sourceUrl:Https,basis:z.literal('owner_reviewed_cross_provider_mapping')}).strict();
export const V1ForecastOutcomeSchema = z.object({ policyVersion: z.literal('verified-first-map-forecast-v1'),
  scheduleBinding:V1ScheduleResultProofSchema.optional(),
  predictionId: z.uuid(), matchId: CatalogIdSchema, checkedAt: Time, status: z.enum(['linked','unlinked']),
  prospectiveEligible: z.boolean(), rosterStatus: z.enum(['matched','mismatched','unknown']), reasons: z.array(z.string()),
  teamASide: z.enum(['radiant','dire']).nullable(), mapNumberEvidence: z.array(z.json()),
  outcome: z.object({ status: z.literal('verified'), matchId: CatalogIdSchema, outcomeReceiptId: CatalogIdSchema,
    teamAId: CatalogIdSchema, teamBId: CatalogIdSchema, teamAWon: z.boolean(), startedAt: Time, completedAt: Time,
    seriesId: z.uuid().nullable(), dataRevision: z.string().regex(/^\d+$/), labelVerifiedAt: Time,
    sourceEvidence: z.object({ receiptId: CatalogIdSchema, payloadSha256: Sha, adapterVersion: z.string(),
      normalizerVersion: z.string(), receiptFetchedAt: Time }).strict() }).strict().nullable()
}).strict().refine(r => (r.status==='linked') === (r.outcome!==null) && (!r.prospectiveEligible || r.status==='linked' && r.reasons.length===0));
export type V1ForecastOutcome = z.infer<typeof V1ForecastOutcomeSchema>;
