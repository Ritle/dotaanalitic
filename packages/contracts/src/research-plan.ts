import { z } from 'zod';
const Time = z.iso.datetime({ precision: 3 });
const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ResearchPlanRequestSchema = z.object({
  schemaVersion: z.literal(1), experiment: z.literal('S3-01 E1'),
  warmupFromAt: Time, holdoutFromAt: Time, holdoutUntil: Time, evaluationNotBefore: Time,
  warmupLeagueIds: z.array(Id).min(1).max(5), maxWarmupCandidates: z.number().int().min(1).max(1000),
  maxExportMaps: z.literal(5000),
  priorExportSha256: Sha, discoverySha256: Sha,
  policy: z.literal('fixed-elo-future-window-v1')
}).strict().refine(r => r.warmupFromAt < r.holdoutFromAt && r.holdoutFromAt < r.holdoutUntil &&
  r.holdoutUntil < r.evaluationNotBefore && new Set(r.warmupLeagueIds).size === r.warmupLeagueIds.length,
  { message: 'invalid_research_plan_windows' });
// Deliberately project metadata only: no winners, scores, durations or performance fields influence selection.
const DiscoveryMap = z.object({ match_id: Id, start_time: z.number().int().positive().max(253402300799),
  leagueid: Id, series_id: Id.nullable(), radiant_team_id: Id.nullable(), dire_team_id: Id.nullable() });
const Source = z.object({ endpoint: z.string(), fetched_at: Time, payload_sha256: Sha });
export const ResearchDiscoverySchema = z.object({
  selection_catalog: z.object({ source_evidence: Source,
    selected_leagues: z.array(z.object({ leagueid: Id, tier: z.string() })).max(20) }),
  cohorts: z.array(z.object({ league_id: Id, tier: z.string(), source_evidence: Source,
    endpoint_completeness: z.literal('unknown'), series_membership_completeness: z.literal('unknown'),
    projection_scope: z.literal('retrospective_discovery_only'), matches: z.array(DiscoveryMap).max(20000) })).max(20)
});
export type ResearchPlanRequest = z.infer<typeof ResearchPlanRequestSchema>;
