import { createHash } from 'node:crypto';
import { releasePlanFixture } from '../../db/tests/v1-release-plan-fixtures.js';
import { planV1Release } from '../../db/src/v1-release-plan.js';
import { registerV1Candidate } from '../../db/src/v1-candidate.js';
import { freezeV1ReleaseInventory } from '../../db/src/v1-release-inventory.js';
import { canonicalContextJson } from '../../db/src/temporal.js';
import { buildEvaluationDiscoveryLedger } from '../src/evaluation-discovery.js';
import { validateEvaluationDetails } from '../src/evaluation-details.js';
import { seriesId } from '../../db/tests/research-elo-fixtures.js';
export const releaseSha = (s: string) => createHash('sha256').update(s).digest('hex');
const micros = (s: string) => (BigInt(Date.parse(s)) * 1000n).toString();
export function releaseEvidenceFixture(base = releasePlanFixture()) {
  const plan = planV1Release(base.request, base.catalogue, base.development, base.registeredAt);
  const planSha = releaseSha(JSON.stringify(plan)), code = [{ path: 'synthetic/kernel.js', sha256: 'a'.repeat(64) }];
  const candidate = registerV1Candidate(plan, base.catalogue, base.development, planSha, code,
    new Date(Date.parse(plan.registeredAt) + 3600000).toISOString());
  const at = new Date(Date.parse(plan.testFromAt) + 2 * 86400000).toISOString();
  const source = structuredClone(base.development.source);
  for (const map of source.candidates) if (map.outcome.status === 'verified') map.outcome.labelVerifiedAt = plan.request.snapshotAt;
  const rows = ['201', '202'].map((matchId, index) => ({ match_id: matchId, leagueid: '77', series_id: matchId,
    start_time: Date.parse(plan.testFromAt) / 1000 + (12 + index * 24) * 3600, radiant_team_id: '111', dire_team_id: '222' }));
  const rawBody = JSON.stringify(rows), limits = { maxProPages: 1, maxLeagues: 1 };
  const entries = ['/leagues/77/matches'].map((endpoint, sequence) => ({ status: 'captured' as const,
    sequence, endpoint, fetchedAt: at, rawBody, payloadSha256: releaseSha(rawBody) }));
  const scope = { schemaVersion: 1 as const, kind: 'v1' as const, planFingerprint: plan.fingerprint, planSha256: planSha,
    windows: plan.request.events.map(e => ({ fromAt: e.fromAt, until: e.until, leagueId: e.leagueId })),
    snapshotAt: plan.request.snapshotAt, maxMaps: 5000 as const };
  const ledger = buildEvaluationDiscoveryLedger(scope, entries, at, at, limits, []);
  const observation = (endpoint: string, data: unknown, matchId: string | null) => {
    const rawBody = JSON.stringify(data);
    return { status: 'captured' as const, endpoint, matchId, observation: { rawBody, source: { provider: 'opendota' as const,
      adapterVersion: 'synthetic-release', endpoint, fetchedAt: at, knownAt: null, payloadSha256: releaseSha(rawBody),
      attempts: 1, rateLimitRemaining: { minute: null, day: null, month: null } } } };
  };
  const detailEntries = [
    observation('/heroes', Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `synthetic_${i}`, localized_name: `Synthetic ${i}` })), null),
    observation('/leagues', [{ leagueid: 77, name: 'Synthetic main event', tier: 'professional' }], null),
    ...rows.map(row => {
      const map = structuredClone(source.candidates[0]!);
      const start = new Date(row.start_time * 1000).toISOString(), end = new Date((row.start_time + 1800) * 1000).toISOString();
      map.matchId = row.match_id; map.startedAtUs = micros(start); map.endedAtUs = micros(end); map.seriesId = seriesId(Number(row.match_id));
      map.syncedAtUs = micros(at); map.facts = [];
      const detail = observation(`/matches/${row.match_id}`, { ...row, duration: 1800, radiant_win: map.radiantWin,
        players: map.players.map((p, i) => ({ player_slot: p.playerSlot, account_id: p.sourceAccountId, hero_id: i + 1 })) }, row.match_id);
      if (map.outcome.status !== 'verified') throw Error('fixture_outcome');
      map.outcome = { ...map.outcome, matchId: map.matchId, seriesId: map.seriesId, startedAt: start, completedAt: end,
        outcomeReceiptId: row.match_id, sourceEvidence: { ...map.outcome.sourceEvidence, receiptId: row.match_id,
          receiptFetchedAt: at, payloadSha256: detail.observation.source.payloadSha256 } };
      source.candidates.push(map); source.aliases.push({ seriesId: map.seriesId, provider: 'opendota', providerSeriesId: row.series_id,
        teamAId: '11', teamBId: '22' });
      return detail;
    })
  ];
  const inventory = freezeV1ReleaseInventory({ schemaVersion: 1, format: 'v1-release-inventory-v1',
    source: { ...source, request: { fromAt: plan.request.warmupFromAt, toAt: plan.request.snapshotAt,
      snapshotAt: plan.request.snapshotAt, maxMaps: 5000 } }, inventoryScope: 'all_local_maps_remote_completeness_unknown',
    metadata: source.candidates.map(m => ({ matchId: m.matchId, leagueId: Number(m.matchId) < 200 ? '78' : '77',
      radiantProviderTeamId: '111', direProviderTeamId: '222' })) });
  const batches = [validateEvaluationDetails(ledger, detailEntries, 0, at, at)];
  const files = { planPath: 'synthetic-plan.json', planSha256: planSha, cataloguePath: 'synthetic-catalogue.json',
    developmentPath: 'synthetic-development.json', candidatePath: 'synthetic-candidate.json', candidateSha256: 'a'.repeat(64),
    evidence: { configPath: 'synthetic-config.json', configSha256: 'b'.repeat(64), unionPath: 'synthetic-union.json',
      unionSha256: 'c'.repeat(64), batches: [{ directory: 'synthetic-detail', manifestSha256: 'd'.repeat(64) }] } };
  return { base, plan, candidate, code, at, rows, entries, ledger, detailEntries, inventory, batches, files, limits };
}
export function reseal<T extends { fingerprint: string }>(value: T): T {
  const { fingerprint: _old, ...body } = value;
  return { ...body, fingerprint: releaseSha(canonicalContextJson(body)) } as T;
}
