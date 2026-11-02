import { createHash } from 'node:crypto';
import { buildEvaluationDiscoveryLedger } from '../src/evaluation-discovery.js';
import { v1Fixture } from '../../db/tests/v1-data-fixtures.js';
import { prepareV1Data } from '../../db/src/v1-data.js';
import type { ProviderObservation } from '../src/opendota/client.js';
export const detailTime = '2026-11-01T22:00:00.000Z';
export function detailObservation(endpoint: string, data: unknown): ProviderObservation<unknown> {
  const rawBody = JSON.stringify(data);
  return { data, rawBody, source: { provider: 'opendota', adapterVersion: 'synthetic-detail-test', endpoint,
    fetchedAt: detailTime, knownAt: null, payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
    attempts: 1, rateLimitRemaining: { minute: null, day: null, month: null } } };
}
export function detailsFixture() {
  const source = v1Fixture(), map = source.candidates[0]!;
  source.request.snapshotAt = '2026-11-02T00:00:00.000Z';
  for (const row of source.candidates) if (row.outcome.status === 'verified') row.outcome.labelVerifiedAt = source.request.snapshotAt;
  const row = { match_id: map.matchId, start_time: Number(BigInt(map.startedAtUs) / 1000000n),
    leagueid: '77', series_id: '1', radiant_team_id: '111', dire_team_id: '222' };
  const pro = detailObservation('/proMatches', [row]);
  const ledger = buildEvaluationDiscoveryLedger({ schemaVersion: 1, kind: 'e1', planSha256: 'a'.repeat(64), planFingerprint: 'b'.repeat(64),
    windows: [{ fromAt: source.request.fromAt, until: source.request.toAt, leagueId: null }], maxMaps: 5000,
    snapshotAt: '2026-11-10T00:00:00.000Z' }, [{ status: 'captured', sequence: 0, endpoint: pro.source.endpoint,
      fetchedAt: detailTime, rawBody: pro.rawBody, payloadSha256: pro.source.payloadSha256 }], detailTime, detailTime, { maxProPages: 1, maxLeagues: 1 }, ['PRO_PAGE_LIMIT']);
  const payload = { ...row, duration: 1800, radiant_win: map.radiantWin,
    radiant_team: { team_id: 111, name: 'Synthetic A' }, dire_team: { team_id: 222, name: 'Synthetic B' },
    players: map.players.map((p, i) => ({ player_slot: p.playerSlot, account_id: p.sourceAccountId, hero_id: i + 1 })) };
  const heroes = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `synthetic_${i}`, localized_name: `Synthetic ${i}` }));
  const entries = [detailObservation('/heroes', heroes), detailObservation('/leagues', [{ leagueid: 77, name: 'Synthetic league', tier: 'professional' }]),
    detailObservation(`/matches/${map.matchId}`, payload)].map((observation, i) => ({ status: 'captured', endpoint: observation.source.endpoint,
      matchId: i === 2 ? map.matchId : null, observation: { source: observation.source, rawBody: observation.rawBody } }));
  if (map.outcome.status === 'verified') map.outcome.sourceEvidence.payloadSha256 = entries[2]!.observation.source.payloadSha256;
  return { source, dataset: prepareV1Data(source), ledger, payload, entries, heroes };
}
