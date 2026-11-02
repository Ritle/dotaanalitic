import { randomUUID } from 'node:crypto';
import { ScenarioInputSchema, ScenarioSnapshotSchema, V1RuntimeRequestSchema } from '@dota/contracts';
import { registryHash } from '../src/v1-registry.js';
export function runtimeFixture() {
  const input = ScenarioInputSchema.parse({ title: 'Synthetic single map', teamAId: '11', teamBId: '22',
    scheduledAt: '2099-01-02T00:00:00.000Z', cutoffAt: '2099-01-01T00:00:00.000Z',
    lineupA: Array.from({ length: 5 }, (_, i) => ({ playerId: String(i + 101), rolePos: i + 1 })),
    lineupB: Array.from({ length: 5 }, (_, i) => ({ playerId: String(i + 106), rolePos: i + 1 })),
    expectedLineupA: null, expectedLineupB: null, confirmedByOwner: true,
    context: { seriesId: null, leagueId: '77', mapNumber: null, teamASeriesWinsBefore: null, teamBSeriesWinsBefore: null,
      radiantSlot: null, firstPickSlot: null, venueKind: null, tournamentStage: null } });
  const scenario = ScenarioSnapshotSchema.parse({ id: randomUUID(), revision: 1, input, inputHash: registryHash(input),
    source: 'manual', recordedAt: '2026-10-30T00:00:00.000Z', knownAt: '2026-10-30T00:00:00.000Z',
    eventAt: input.scheduledAt, warnings: ['OWNER_ASSERTION_ONLY'], predictionEligibility: 'not_assessed' });
  const request = V1RuntimeRequestSchema.parse({ requestId: randomUUID(), scenarioId: scenario.id, expectedRevision: 1,
    purpose: 'what_if_single_map', targetScope: { provider: 'opendota', leagueId: '77', eventName: 'Synthetic event',
      fromAt: '2099-01-01T00:00:00.000Z', until: '2099-02-01T00:00:00.000Z', tier: 1, stage: 'main_event',
      sourceUrl: 'https://example.test/synthetic-event', rationale: 'Synthetic owner-reviewed event scope for protocol tests' } });
  return { input, scenario, request };
}
