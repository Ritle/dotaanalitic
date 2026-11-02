import { z } from 'zod';
import { AccountEvidenceSchema, CanonicalPlayerIdSchema, Steam32Schema } from './identity.js';
import { ResearchEloMapSchema } from './research-elo.js';

export const V1_FEATURE_PROFILE = 'player-mean-elo-completed-strict-v1' as const;
const Us = z.string().regex(/^(0|[1-9]\d{0,17})$/);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().min(1).max(512);
const Member = z.object({ playerId: CanonicalPlayerIdSchema, accountId: Steam32Schema
  .refine(id => BigInt(id) < 4294967295n) }).strict();
const Five = z.array(Member).length(5);
export const V1FeatureMapSchema = z.object({
  matchId: CanonicalPlayerIdSchema, seriesKey: Text, startedAtUs: Us, completedAtUs: Us,
  isPro: z.literal(true), teamA: Five, teamB: Five, teamAWon: z.boolean(),
  outcomeReceiptId: CanonicalPlayerIdSchema, payloadSha256: Sha, fetchedAtUs: Us, labelVerifiedAtUs: Us,
  factClocks: ResearchEloMapSchema.shape.facts
}).strict().refine(m => BigInt(m.completedAtUs) > BigInt(m.startedAtUs) &&
  BigInt(m.fetchedAtUs) >= BigInt(m.completedAtUs) && BigInt(m.labelVerifiedAtUs) >= BigInt(m.fetchedAtUs),
  { message: 'invalid_v1_history_clocks' }).refine(m => {
  const members = [...m.teamA, ...m.teamB];
  return new Set(members.map(p => p.playerId)).size === 10 && new Set(members.map(p => p.accountId)).size === 10;
}, { message: 'invalid_v1_history_fives' });

/** Trusted adapter boundary: maps have already passed OutcomeVerifier and whole-series eligibility. */
export const V1FeatureHistorySchema = z.object({
  schemaVersion: z.literal(1), profile: z.literal(V1_FEATURE_PROFILE), sourceFingerprint: Sha,
  identityRevision: Us, snapshotAtUs: Us, warmupFromAtUs: Us, syntheticOnly: z.boolean(),
  identities: z.array(AccountEvidenceSchema.safeExtend({ observationId: Text })).max(100000),
  maps: z.array(V1FeatureMapSchema).max(5000)
}).strict().refine(h => BigInt(h.warmupFromAtUs) <= BigInt(h.snapshotAtUs), { message: 'invalid_v1_history_window' });

export const V1FeatureScenarioSchema = z.object({
  schemaVersion: z.literal(1), cutoffAtUs: Us, targetMatchId: CanonicalPlayerIdSchema.nullable(),
  teamA: Five, teamB: Five,
  lineup: z.object({ basis: z.enum(['manual', 'expected', 'actual_lineup_reconstructed']),
    source: Text, selectedAtUs: Us, revision: Text }).strict()
}).strict().refine(s => {
  const members = [...s.teamA, ...s.teamB];
  return new Set(members.map(p => p.playerId)).size === 10 && new Set(members.map(p => p.accountId)).size === 10;
}, { message: 'invalid_v1_scenario_fives' });
export type V1FeatureHistory = z.infer<typeof V1FeatureHistorySchema>;
export type V1FeatureScenario = z.infer<typeof V1FeatureScenarioSchema>;
export type V1FeatureMap = z.infer<typeof V1FeatureMapSchema>;
