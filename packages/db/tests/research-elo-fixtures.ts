import { ELO_POLICY } from '@dota/analytics';
import type { ResearchEloBody, ResearchEloMap } from '@dota/contracts';
export const micros = (time: string) => (BigInt(Date.parse(time)) * 1000n).toString();
export const seriesId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const date = (day: number) => new Date(Date.UTC(2024, 0, day, 12)).toISOString();
export const sourceTime = '2026-10-30T00:00:00.000Z';
export function researchFixture(): ResearchEloBody {
  const request: ResearchEloBody['request'] = { schemaVersion: 1, cohort: 'research_event_time_reconstructed',
    fromAt: '2024-01-01T00:00:00.000Z', holdoutFromAt: '2024-01-04T00:00:00.000Z',
    toAt: '2024-01-07T00:00:00.000Z', snapshotAt: '2026-10-31T20:00:00.000Z', maxMaps: 100,
    evaluationPolicy: 'event-time-prequential-series-v1' };
  const players = Array.from({ length: 10 }, (_, i) => ({ playerSlot: i < 5 ? i : i + 123, sourceAccountId: String(10001 + i) }));
  const candidates: ResearchEloMap[] = Array.from({ length: 6 }, (_, i) => {
    const id = String(i + 1), startedAt = date(i + 1), completedAt = new Date(Date.parse(startedAt) + 1800000).toISOString();
    return { matchId: id, startedAtUs: micros(startedAt), endedAtUs: micros(completedAt), syncedAtUs: micros(sourceTime),
      dataRevision: '1', isPro: true, ingestState: 'accepted', radiantWin: i % 3 !== 1,
      radiantTeamId: '11', direTeamId: '22', seriesId: seriesId(i + 1), players: structuredClone(players), receiptPlayers: structuredClone(players),
      seriesSourceMatched: true, facts: [{ id, field: 'radiant_win', eventAtUs: micros(completedAt), knownAtUs: null,
        fetchedAtUs: micros(sourceTime), recordedAtUs: null, reviewState: 'unreviewed', availability: 'retrospective_fact' }],
      outcome: { status: 'verified', matchId: id, outcomeReceiptId: id, teamAId: '11', teamBId: '22', teamAWon: i % 3 !== 1,
        startedAt, completedAt, seriesId: seriesId(i + 1), dataRevision: '1', labelVerifiedAt: request.snapshotAt,
        sourceEvidence: { receiptId: id, payloadSha256: 'a'.repeat(64), adapterVersion: 'synthetic', normalizerVersion: 'synthetic', receiptFetchedAt: sourceTime } } };
  });
  return { schemaVersion: 1, format: 'research-elo-export-v1', cohort: request.cohort, request, identityRevision: '1', candidates,
    aliases: candidates.map((m, i) => ({ seriesId: m.seriesId!, provider: 'opendota', providerSeriesId: String(i + 1), teamAId: '11', teamBId: '22' })),
    identities: players.map((p, i) => ({ observationId: `proof:${i + 1}`, playerId: String(i + 101), provider: 'opendota',
      externalAccountId: p.sourceAccountId!, status: 'verified', eventAt: null, knownAt: sourceTime, fetchedAt: sourceTime,
      evidenceRef: `synthetic:account:${i}`, source: 'synthetic-only' })), code: [{ path: 'synthetic:code', sha256: 'b'.repeat(64) }],
    policy: ELO_POLICY, syntheticOnly: true, trainingReady: false, deployable: false };
}
