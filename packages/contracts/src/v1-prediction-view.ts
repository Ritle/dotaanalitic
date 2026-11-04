import { z } from 'zod';
import { V1RuntimeRequestSchema } from './v1-runtime.js';
import { ScenarioSnapshotSchema } from './scenario.js';
import { CanonicalPlayerIdSchema } from './identity.js';
import { V1_FEATURE_PROFILE } from './v1-features.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime({ precision: 3 }), Clock = z.iso.datetime({ precision: 6 });
const N = z.number().int().min(0).max(5000);
export const V1PredictionCreateSchema = V1RuntimeRequestSchema.omit({ scenarioId: true });
export const V1PredictionCoverageSchema = z.object({ nRaw: N, nEff: z.number().min(0).max(5000), minimumPlayerMaps: N,
  playersWithHistory: z.number().int().min(0).max(10), playersMeetingMinimum: z.number().int().min(0).max(10) }).strict();
const Player = z.object({ playerId: CanonicalPlayerIdSchema, maps: N, reason: z.string().nullable() }).strip();
/** Deliberately small read projection: raw receipts, artifact bytes and code manifests remain in storage. */
export const V1PredictionViewSchema = z.object({
  id: z.uuid(), requestId: z.uuid(), snapshotSha256: Sha, purpose: z.literal('what_if_single_map'), stage: z.literal('pre_match'),
  scenario: ScenarioSnapshotSchema, createdAt: Clock, issuedAt: Clock.nullable(), cutoffAt: Time,
  status: z.enum(['done', 'unavailable']), teamAWinProbability: z.number().min(0).max(1).nullable(),
  reasons: z.array(z.string()), warnings: z.array(z.string()), targetScope: V1RuntimeRequestSchema.shape.targetScope,
  model: z.object({ id: z.uuid().nullable(), eligibleAtCalculation: z.boolean(), featureProfile: z.literal(V1_FEATURE_PROFILE),
    candidateSha256: Sha.nullable(), freezeSha256: Sha.nullable(), reportSha256: Sha.nullable() }).strict(),
  history: z.object({ sourceFingerprint: Sha, snapshotAt: Time, fromAt: Time, toAt: Time,
    identityRevision: z.string().regex(/^\d+$/), remoteCompleteness: z.literal('unknown'), tiers: z.literal('all_verified_pro') }).strict().nullable(),
  coverage: V1PredictionCoverageSchema.nullable(),
  players: z.object({ teamA: z.array(Player).length(5), teamB: z.array(Player).length(5) }).strict().nullable()
}).strict().refine(s => s.status === 'done' ? s.teamAWinProbability !== null && s.issuedAt !== null && s.reasons.length === 0 && s.model.eligibleAtCalculation :
  s.teamAWinProbability === null && s.issuedAt === null && s.reasons.length > 0);
export const V1PredictionHistorySchema = z.object({ items: z.array(z.object({
  id: z.uuid(), requestId: z.uuid(), scenarioRevision: z.number().int().positive(), createdAt: Clock,
  status: z.enum(['done', 'unavailable'])
}).strict()).max(20), hasMore: z.boolean() }).strict();
// Parse the known portions of immutable internal snapshots without exposing their unrestricted JSON.
export const V1PredictionFeatureViewSchema = z.object({ coverage: V1PredictionCoverageSchema,
  teamA: z.array(Player).length(5), teamB: z.array(Player).length(5) }).strip();
export const V1PredictionSourceViewSchema = z.object({ fingerprint: Sha, source: z.object({ identityRevision: z.string().regex(/^\d+$/),
  request: z.object({ snapshotAt: Time, fromAt: Time, toAt: Time }).strip() }).strip() }).strip();
export const V1PredictionGateViewSchema = z.object({ status: z.enum(['model_eligible', 'unavailable']), modelId: z.uuid().nullable(),
  candidateSha256: Sha.optional(), freezeSha256: Sha.optional(), reportSha256: Sha.optional() }).strip();
export type V1PredictionView = z.infer<typeof V1PredictionViewSchema>;
export type V1PredictionCreate = z.infer<typeof V1PredictionCreateSchema>;
