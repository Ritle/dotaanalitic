import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { buildV1Features } from '@dota/prediction';
import { V1RuntimeRequestSchema, V1RuntimeSnapshotSchema } from '@dota/contracts';
import { runtimeFeatureScenario, runtimeTargetReasons, computeV1RuntimeFeatures } from '../src/v1-runtime.js';
import { compatibleV1Runtime, readV1RuntimeCode, V1_RUNTIME_KERNEL_PATHS } from '../src/v1-runtime-code.js';
import { prepareV1PerMapFeatureHistory } from '../src/v1-features.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
import { v1Fixture } from './v1-data-fixtures.js';
const cutoff = '2026-10-31T20:00:00.000Z';
it('requires explicit event scope, verified league mapping, a future start and no between-map context', () => {
  const { request, scenario } = runtimeFixture();
  expect(runtimeTargetReasons(request, scenario, cutoff, '77')).toEqual([]);
  expect(runtimeTargetReasons({ ...request, targetScope: null }, scenario, cutoff, '77')).toContain('TIER1_SCOPE_NOT_REVIEWED');
  expect(runtimeTargetReasons(request, scenario, cutoff, '78')).toContain('TARGET_OUTSIDE_REVIEWED_TIER1_SCOPE');
  expect(runtimeTargetReasons(request, scenario, scenario.input.scheduledAt!, '77')).toContain('TARGET_ALREADY_STARTED');
  scenario.input.context.mapNumber = 2;
  expect(runtimeTargetReasons(request, scenario, cutoff, '77')).toContain('BETWEEN_MAP_PREDICTION_UNSUPPORTED');
  scenario.input.scheduledAt = null;
  expect(runtimeTargetReasons(request, scenario, cutoff, '77')).toContain('TARGET_START_UNKNOWN');
});
it('uses canonical numeric identities, ignores roles/patch/side and preserves swapped A/B arithmetic', () => {
  const history = prepareV1PerMapFeatureHistory(v1Fixture()), { scenario } = runtimeFixture();
  const first = runtimeFeatureScenario(history, scenario, cutoff)!;
  const result = buildV1Features(history, first);
  expect(result.status).toBe('ready');
  expect(result.coverage.minimumPlayerMaps).toBe(6);
  [scenario.input.lineupA, scenario.input.lineupB] = [scenario.input.lineupB, scenario.input.lineupA];
  scenario.input.context.radiantSlot = 'B';
  const swapped = buildV1Features(history, runtimeFeatureScenario(history, scenario, cutoff));
  expect(swapped.features!.eloDifference).toBe(-result.features!.eloDifference);
  expect(() => computeV1RuntimeFeatures(history, scenario, cutoff, null)).toThrow('runtime_synthetic_forbidden');
});
it('refuses identity conflict, multiple accounts, future evidence and duplicate players', () => {
  const { scenario } = runtimeFixture();
  for (const mode of ['conflict', 'multiple', 'future', 'duplicate']) {
    const history = prepareV1PerMapFeatureHistory(v1Fixture()), input = structuredClone(scenario);
    if (mode === 'conflict') history.identities.push({ ...history.identities[0]!, observationId: 'extra', playerId: '999' });
    if (mode === 'multiple') history.identities.push({ ...history.identities[0]!, observationId: 'extra', externalAccountId: '22222' });
    if (mode === 'future') history.identities[0]!.fetchedAt = '2099-01-01T00:00:00.000Z';
    if (mode === 'duplicate') input.input.lineupA[0]!.playerId = input.input.lineupB[0]!.playerId;
    expect(runtimeFeatureScenario(history, input, cutoff), mode).toBeNull();
  }
});
it('never uses a map ending exactly at cutoff and refuses a lineup selected at cutoff', () => {
  const history = prepareV1PerMapFeatureHistory(v1Fixture()), { scenario } = runtimeFixture();
  history.maps[5]!.completedAtUs = (BigInt(Date.parse(cutoff)) * 1000n).toString();
  history.maps[5]!.fetchedAtUs = history.maps[5]!.completedAtUs;
  const result = buildV1Features(history, runtimeFeatureScenario(history, scenario, cutoff));
  expect(result.coverage.minimumPlayerMaps).toBe(5);
  scenario.recordedAt = cutoff;
  expect(buildV1Features(history, runtimeFeatureScenario(history, scenario, cutoff)).reasons).toContain('LINEUP_NOT_SELECTED_BEFORE_START');
});
it('forbids prospective relabeling, caller probabilities, invalid scope and malformed terminal snapshots', () => {
  const { request } = runtimeFixture();
  for (const input of [{ ...request, purpose: 'real_map' }, { ...request, teamAWinProbability: 0.7 },
    { ...request, targetScope: { ...request.targetScope, tier: 2 } }]) expect(V1RuntimeRequestSchema.safeParse(input).success).toBe(false);
  expect(V1RuntimeSnapshotSchema.safeParse({ status: 'unavailable', teamAWinProbability: 0.5 }).success).toBe(false);
});
it('rejects the archived reader freeze and requires exact current code, barrel bindings and runtime', async () => {
  const archived = JSON.parse(await readFile(new URL('../../../docs/evidence/s3-03-v1-executable-freeze.json', import.meta.url), 'utf8'));
  const actual = await readV1RuntimeCode();
  expect(compatibleV1Runtime(archived, actual)).toBe(false);
  expect(V1_RUNTIME_KERNEL_PATHS.filter(path => archived.code.find((c: {path:string;sha256:string}) => c.path === path)?.sha256 !==
    actual.code.find(c => c.path === path)?.sha256)).toEqual(['packages/db/dist/v1-data-repository.js','packages/db/dist/v1-fact-pages.js']);
  // In-memory test fixture only: no new model freeze or release approval is created.
  const freeze = { ...archived, code: actual.code };
  expect(compatibleV1Runtime(freeze, actual)).toBe(true);
  const altered = structuredClone(actual); altered.code.find(c => c.path.endsWith('prediction/dist/v1-features.js'))!.sha256 = '0'.repeat(64);
  expect(compatibleV1Runtime(freeze, altered)).toBe(false);
  altered.code = actual.code; altered.barrels[0]!.text += 'throw Error("changed binding");\n';
  expect(compatibleV1Runtime(freeze, altered)).toBe(false);
  expect(compatibleV1Runtime(freeze, { ...actual, runtime: { ...actual.runtime, node: 'v0.0.0' } })).toBe(false);
});
