import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { V1PredictionViewSchema, V1RuntimeSnapshotSchema } from '@dota/contracts';
import { predictionView, V1PredictionService } from '../src/v1-prediction-reader.js';
import { V1RuntimeRepository } from '../src/v1-runtime-repository.js';
import { createDatabase } from '../src/index.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
const saved = () => {
  const f = runtimeFixture();
  return { id: randomUUID(), sha256: 'a'.repeat(64), snapshot: V1RuntimeSnapshotSchema.parse({
    format: 'v1-runtime-snapshot-v1', request: f.request, scenario: f.scenario, createdAt: '2026-11-02T12:00:00.123456Z',
    issuedAt: null, cutoffAt: '2026-11-02T12:00:00.123Z', status: 'unavailable', teamAWinProbability: null,
    reasons: ['NO_ACTIVE_MODEL'], gate: { status: 'unavailable', modelId: null, privateField: 'internal-do-not-send' },
    code: { file: 'private-path' }, source: null, features: null, warnings: ['CONDITIONAL_ON_MANUAL_LINEUPS'], targetReview: {} }) };
};
it('projects only documented fields, preserving zero-vs-unknown and full server clocks', () => {
  const input = saved(), result = predictionView(input);
  expect(result).toMatchObject({ teamAWinProbability: null, coverage: null, history: null, players: null,
    createdAt: '2026-11-02T12:00:00.123456Z', model: { id: null, eligibleAtCalculation: false } });
  expect(JSON.stringify(result)).not.toMatch(/internal-do-not-send|private-path|targetReview|identityProofIds/);
  input.snapshot.features = { coverage: { nRaw: 0, nEff: 0, minimumPlayerMaps: 0, playersWithHistory: 0, playersMeetingMinimum: 0 },
    teamA: input.snapshot.scenario.input.lineupA.map(p => ({ playerId: p.playerId, maps: 0, reason: null, identityProofIds: ['private-proof'] })),
    teamB: input.snapshot.scenario.input.lineupB.map(p => ({ playerId: p.playerId, maps: 0, reason: null, identityProofIds: ['private-proof'] })) };
  expect(predictionView(input).coverage?.nRaw).toBe(0); expect(JSON.stringify(predictionView(input))).not.toContain('private-proof');
});
it('retains the issued probability and saved model evidence without consulting the current model state', () => {
  const input = saved(); input.snapshot.status = 'done'; input.snapshot.teamAWinProbability = 0.5000000001;
  input.snapshot.issuedAt = '2026-11-02T12:00:01.123456Z'; input.snapshot.reasons = [];
  input.snapshot.gate = { status: 'model_eligible', modelId: randomUUID(), candidateSha256: 'b'.repeat(64), freezeSha256: 'c'.repeat(64), reportSha256: 'd'.repeat(64) };
  expect(predictionView(input)).toMatchObject({ status: 'done', teamAWinProbability: 0.5000000001, model: { eligibleAtCalculation: true } });
  input.snapshot.status = 'unavailable'; expect(() => predictionView(input)).toThrow();
});
it('rejects malformed stored feature projections instead of presenting invented coverage', () => {
  const input = saved(); input.snapshot.features = { coverage: { nRaw: '5' } };
  expect(() => predictionView(input)).toThrow();
  expect(V1PredictionViewSchema.safeParse({ ...predictionView(saved()), extra: 'unknown' }).success).toBe(false);
});
it('bounds concurrent admission before allocating DB transactions and clears the slot after failure', async () => {
  const db = createDatabase('postgresql://unused@127.0.0.1:1/unused');
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const mock = vi.spyOn(V1RuntimeRepository.prototype, 'create').mockImplementationOnce(async () => { await wait; throw Error('synthetic source failure'); });
  try {
    const service = await V1PredictionService.open(db), input = runtimeFixture().request;
    const running = service.create(randomUUID(), input), failure = expect(running).rejects.toThrow('synthetic source failure');
    await expect(service.create(randomUUID(), input)).rejects.toThrow('runtime_request_busy');
    expect(mock).toHaveBeenCalledTimes(1); release(); await failure;
    mock.mockRejectedValueOnce(Error('synthetic next attempt'));
    await expect(service.create(randomUUID(), input)).rejects.toThrow('synthetic next attempt');
  } finally { release(); vi.restoreAllMocks(); await db.destroy(); }
});
