import { createHash } from 'node:crypto';
import { executionFixture } from '../../db/tests/research-execution-fixtures.js';
import { freezeResearchElo } from '../../db/src/research-elo.js';
import { buildEvaluationDiscoveryLedger } from '../src/evaluation-discovery.js';
import { validateEvaluationDetails, selectEvaluationDetailBatch } from '../src/evaluation-details.js';
export const evidenceTime = '2026-11-04T00:00:00.000Z';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export function evidenceFixture(ids = ['201', '202'], conflict = false, base = executionFixture()) {
  const f = base;
  const evidenceTime = new Date(Date.parse(f.plan.request.holdoutFromAt) + 2 * 86400000).toISOString();
  const rows = ids.map(id => ({ match_id: id, start_time: (Date.parse(f.plan.request.holdoutFromAt) + (id === '201' ? 12 : 36) * 3600000) / 1000,
    leagueid: '77', series_id: id === '203' ? '201' : id, radiant_team_id: '111', dire_team_id: '222' }));
  if (conflict) rows.push({ ...rows[0]!, series_id: '202' });
  const rawBody = JSON.stringify(rows);
  const ledger = buildEvaluationDiscoveryLedger({ schemaVersion: 1, kind: 'e1', planFingerprint: f.plan.fingerprint, planSha256: 'a'.repeat(64),
    windows: [{ fromAt: f.plan.request.holdoutFromAt, until: f.plan.request.holdoutUntil, leagueId: null }],
    snapshotAt: f.now, maxMaps: 5000 }, [{ status: 'captured', sequence: 0, endpoint: '/proMatches', rawBody,
    fetchedAt: evidenceTime, payloadSha256: digest(rawBody) }], evidenceTime, evidenceTime, { maxProPages: 1, maxLeagues: 1 }, ['PRO_PAGE_LIMIT']);
  const observation = (endpoint: string, data: unknown, matchId: string | null) => {
    const rawBody = JSON.stringify(data);
    return { status: 'captured' as const, endpoint, matchId, observation: { rawBody, source: { provider: 'opendota' as const,
      adapterVersion: 'synthetic-research-evidence', endpoint, fetchedAt: evidenceTime, knownAt: null,
      payloadSha256: digest(rawBody), attempts: 1, rateLimitRemaining: { minute: null, day: null, month: null } } } };
  };
  const captures = Array.from({ length: Math.ceil(ids.length / 50) }, (_, batchIndex) => {
    const selection = selectEvaluationDetailBatch(ledger, batchIndex);
    const entries = [observation('/heroes', Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `synthetic_${i}`, localized_name: `Synthetic ${i}` })), null),
      observation('/leagues', [{ leagueid: 77, name: 'Synthetic league', tier: 'professional' }], null),
      ...selection.selectedIds.map(id => {
        const map = f.snapshot.candidates.find(m => m.matchId === id) ?? f.snapshot.candidates.find(m => m.matchId === '201')!;
        const entry = observation(`/matches/${id}`, { ...rows.find(r => r.match_id === id), duration: 1800, radiant_win: map.radiantWin,
          radiant_team: { team_id: 111, name: 'Synthetic A' }, dire_team: { team_id: 222, name: 'Synthetic B' },
          players: map.players.map((p, i) => ({ player_slot: p.playerSlot, account_id: p.sourceAccountId, hero_id: i + 1 })) }, id);
        if (map.matchId === id && map.outcome.status === 'verified') map.outcome.sourceEvidence.payloadSha256 = entry.observation.source.payloadSha256;
        return entry;
      })];
    return { entries, report: validateEvaluationDetails(ledger, entries, batchIndex, evidenceTime, evidenceTime).report };
  });
  const { fingerprint: _old, ...body } = f.snapshot;
  const snapshot = freezeResearchElo(body);
  const files = { configPath: 'synthetic-config.json', configSha256: 'a'.repeat(64), unionPath: 'synthetic-union.json',
    unionSha256: 'b'.repeat(64), batches: captures.map((_, i) => ({ directory: `synthetic-${i}`, manifestSha256: digest(String(i)) })) };
  return { ...f, snapshot, ledger, captures, batches: captures.map(c => c.report), files };
}
