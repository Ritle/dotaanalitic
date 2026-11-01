import { createHash } from 'node:crypto';
import { researchFixture } from './research-elo-fixtures.js';
import { freezeResearchElo } from '../src/research-elo.js';
export const registeredAt = '2026-11-01T21:00:00.000Z';
export const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export function planFixture() {
  const prior = freezeResearchElo(researchFixture());
  const evidence = { endpoint: '/leagues', fetched_at: '2026-10-31T12:00:00.000Z', payload_sha256: 'a'.repeat(64) };
  const discovery = { selection_catalog: { source_evidence: evidence, selected_leagues: [{ leagueid: '77', tier: 'professional' }] },
    cohorts: [{ league_id: '77', tier: 'professional', source_evidence: { ...evidence, endpoint: '/leagues/77/matches' },
      endpoint_completeness: 'unknown', series_membership_completeness: 'unknown', projection_scope: 'retrospective_discovery_only',
      matches: [101, 102, 103].map((id, i) => ({ match_id: String(id), start_time: Date.parse(`2025-02-0${i + 1}T12:00:00Z`) / 1000,
        leagueid: '77', series_id: i < 2 ? '99' : '100', radiant_team_id: '11', dire_team_id: '22', radiant_win: true })) }] };
  const request = { schemaVersion: 1, experiment: 'S3-01 E1', warmupFromAt: '2020-01-01T00:00:00.000Z',
    holdoutFromAt: '2026-11-02T00:00:00.000Z', holdoutUntil: '2026-11-09T00:00:00.000Z', evaluationNotBefore: '2026-11-10T00:00:00.000Z',
    warmupLeagueIds: ['77'], maxWarmupCandidates: 200, maxExportMaps: 5000,
    priorExportSha256: digest(JSON.stringify(prior)), discoverySha256: digest(JSON.stringify(discovery)), policy: 'fixed-elo-future-window-v1' };
  return { request, prior, discovery };
}
