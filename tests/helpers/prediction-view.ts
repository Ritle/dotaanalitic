import { V1PredictionViewSchema } from '../../packages/contracts/src/v1-prediction-view.js';
import { runtimeFixture } from '../../packages/db/tests/v1-runtime-fixtures.js';
/** Synthetic presentation fixture only; never inserted into a production model or dataset. */
export function predictionViewFixture(scenarioId?: string) {
  const f = runtimeFixture(); if (scenarioId) f.scenario.id = scenarioId;
  f.scenario.input.title = 'Синтетический пример отображения прогноза';
  return V1PredictionViewSchema.parse({ id: '10000000-0000-4000-8000-000000000001', requestId: f.request.requestId,
    snapshotSha256: 'a'.repeat(64), purpose: 'what_if_single_map', stage: 'pre_match', scenario: f.scenario,
    createdAt: '2026-11-02T12:00:00.123456Z', issuedAt: '2026-11-02T12:00:01.123456Z', cutoffAt: '2026-11-02T12:00:00.123Z',
    status: 'done', teamAWinProbability: 0.5000000001, reasons: [], warnings: ['SYNTHETIC_PRESENTATION_FIXTURE'], targetScope: null,
    model: { id: '20000000-0000-4000-8000-000000000001', eligibleAtCalculation: true, featureProfile: 'player-mean-elo-completed-strict-v1',
      candidateSha256: 'b'.repeat(64), freezeSha256: 'c'.repeat(64), reportSha256: 'd'.repeat(64) },
    history: { sourceFingerprint: 'e'.repeat(64), snapshotAt: '2026-11-02T12:00:00.123Z', fromAt: '2024-01-01T00:00:00.000Z',
      toAt: '2026-11-02T12:00:00.123Z', identityRevision: '1', remoteCompleteness: 'unknown', tiers: 'all_verified_pro' },
    coverage: { nRaw: 6, nEff: 6, minimumPlayerMaps: 6, playersWithHistory: 10, playersMeetingMinimum: 10 },
    players: { teamA: f.scenario.input.lineupA.map(p => ({ playerId: p.playerId, maps: 6, reason: null })),
      teamB: f.scenario.input.lineupB.map(p => ({ playerId: p.playerId, maps: 6, reason: null })) } });
}
