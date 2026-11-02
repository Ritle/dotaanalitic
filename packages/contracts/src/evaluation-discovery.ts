import { z } from 'zod';
const Decimal = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const RawId = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^(0|[1-9]\d{0,18})$/)])
  .transform(String).refine(v => /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n);
const OptionalId = RawId.nullish().transform(v => v === undefined || v === '0' ? null : v);
const Time = z.iso.datetime({ precision: 3 });
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
// Deliberately ignore winners, scores, duration, players and all post-start performance fields.
export const EvaluationDiscoveryRowsSchema = z.array(z.object({
  match_id: RawId.refine(v => v !== '0'),
  start_time: z.number().int().min(1).max(253402300799).nullish().transform(v => v ?? null),
  leagueid: OptionalId, series_id: OptionalId, radiant_team_id: OptionalId, dire_team_id: OptionalId
})).max(20000);
export const EvaluationDiscoveryScopeSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(['e1', 'v1']), planSha256: Sha, planFingerprint: Sha,
  windows: z.array(z.object({ fromAt: Time, until: Time, leagueId: Decimal.nullable() }).strict()).min(1).max(5),
  maxMaps: z.literal(5000), snapshotAt: Time
}).strict().refine(s => s.windows.every(w => w.fromAt < w.until && (s.kind === 'e1' ? w.leagueId === null : w.leagueId !== null)),
{ message: 'invalid_discovery_scope' });
export const EvaluationDiscoveryEntrySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('captured'), sequence: z.number().int().min(0),
    endpoint: z.string().regex(/^\/proMatches(?:\?less_than_match_id=[1-9]\d*)?$|^\/leagues\/[1-9]\d*\/matches$/),
    fetchedAt: Time, payloadSha256: Sha, rawBody: z.string().max(8388608) }).strict(),
  z.object({ status: z.literal('failed'), sequence: z.number().int().min(0),
    endpoint: z.string().regex(/^\/proMatches(?:\?less_than_match_id=[1-9]\d*)?$|^\/leagues\/[1-9]\d*\/matches$/),
    failedAt: Time, code: z.string().regex(/^[a-z_]{1,80}$/) }).strict()
]);
export const EvaluationDiscoveryLimitsSchema = z.object({
  maxProPages: z.number().int().min(1).max(10), maxLeagues: z.number().int().min(1).max(10)
}).strict();
export const EvaluationDiscoveryCommandSchema = z.object({
  kind: z.enum(['e1', 'v1']), planPath: z.string().min(1).max(1024), planSha256: Sha,
  evidenceAPath: z.string().min(1).max(1024), evidenceBPath: z.string().min(1).max(1024),
  limits: EvaluationDiscoveryLimitsSchema
}).strict();
export type EvaluationDiscoveryScope = z.infer<typeof EvaluationDiscoveryScopeSchema>;
export type EvaluationDiscoveryEntry = z.infer<typeof EvaluationDiscoveryEntrySchema>;
export type EvaluationDiscoveryLimits = z.infer<typeof EvaluationDiscoveryLimitsSchema>;
