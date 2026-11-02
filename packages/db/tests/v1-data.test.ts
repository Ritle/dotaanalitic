import { expect, it } from 'vitest';
import { V1DataRequestSchema, type V1DataSource } from '@dota/contracts';
import { prepareV1Data, verifyV1Data } from '../src/v1-data.js';
import { canonicalContextJson } from '../src/temporal.js';
import { createHash } from 'node:crypto';
import { micros } from './research-elo-fixtures.js';

import { v1Fixture } from './v1-data-fixtures.js';
const prepare = (source = v1Fixture()) => prepareV1Data(source);

it('prepares without patch/roles/heroes and leaves source clocks, model gates and splits honest', () => {
  const source = v1Fixture(), before = JSON.stringify(source), frozen = prepare(source);
  expect(JSON.stringify(source)).toBe(before);
  expect(frozen.report).toMatchObject({ status: 'prepared', summary: { eligibleMaps: 6, eligibleSeries: 6,
    mapsWithAllPlayersHistory: 5, mapsWithNoPlayerHistory: 1 }, evaluation: 'not_performed',
    split: 'unassigned_development', trainingReady: false, deployable: false, teamAWinProbability: null });
  expect(frozen.source.candidates[0]!.facts[0]!.knownAtUs).toBeNull();
  expect(frozen.source.identities[0]!.knownAt).toBe(source.identities[0]!.knownAt);
  expect(frozen.report.examples[5]!.historyCoverage.priorMapsPerPlayer).toEqual(Array(10).fill(5));
  expect(JSON.stringify(frozen.report.examples.map(e => e.inputs))).not.toMatch(/teamAWon|radiantWin|completedAt|hero|role|patch|kills|gpm/);
  expect(verifyV1Data(frozen)).toEqual(frozen);
});
it('rejects changed SHA and recomputes a forged assessment even if its internal hash was updated', () => {
  const frozen = prepare(); frozen.report.summary.eligibleMaps = 0;
  expect(() => verifyV1Data(frozen)).toThrow('v1_dataset_fingerprint_mismatch');
  const { fingerprint: _old, ...body } = frozen;
  frozen.fingerprint = createHash('sha256').update(canonicalContextJson(body)).digest('hex');
  expect(() => verifyV1Data(frozen)).toThrow('v1_dataset_replay_mismatch');
});
it('canonicalizes all record order without changing frozen content', () => {
  const source = v1Fixture(), first = prepare(source);
  source.candidates.reverse(); source.aliases.reverse(); source.identities.reverse();
  for (const m of source.candidates) { m.players.reverse(); m.receiptPlayers.reverse(); m.facts.reverse(); }
  expect(prepare(source)).toEqual(first);
});
it('counts only maps completed strictly before target start, never ongoing or equal-time outcomes', () => {
  const source = v1Fixture(), first = source.candidates[0]!, second = source.candidates[1]!;
  first.endedAtUs = second.startedAtUs;
  if (first.outcome.status === 'verified' && second.outcome.status === 'verified') first.outcome.completedAt = second.outcome.startedAt;
  const frozen = prepare(source);
  expect(frozen.report.examples[1]!.historyCoverage.priorMapsPerPlayer).toEqual(Array(10).fill(0));
  expect(frozen.report.examples[2]!.historyCoverage.priorMapsPerPlayer).toEqual(Array(10).fill(2));
});
it('future outcome changes do not change earlier inputs or history coverage', () => {
  const source = v1Fixture(), first = prepare(source).report.examples;
  const m = source.candidates[5]!; m.radiantWin = !m.radiantWin;
  if (m.outcome.status === 'verified') m.outcome.teamAWon = m.radiantWin;
  const second = prepare(source).report.examples;
  expect(second.map(e => [e.inputs, e.historyCoverage])).toEqual(first.map(e => [e.inputs, e.historyCoverage]));
});
it('maps native slots independently of array order and preserves career history across organizations', () => {
  const source = v1Fixture(), m = source.candidates[3]!; m.radiantTeamId = '33';
  if (m.outcome.status === 'verified') m.outcome.teamAId = '33'; source.aliases[3]!.teamAId = '33';
  expect(prepare(source).report.examples[3]!.historyCoverage.priorMapsPerPlayer).toEqual(Array(10).fill(3));
  for (const map of source.candidates) {
    map.players.forEach(p => { p.playerSlot = p.playerSlot < 128 ? p.playerSlot + 128 : p.playerSlot - 128; });
    map.receiptPlayers = structuredClone(map.players);
  }
  expect(prepare(source).report.examples[0]!.inputs.teamAPlayerIds).toEqual(['106', '107', '108', '109', '110']);
});
it('rejects duplicates and incomplete/mismatched rosters, outcomes, pro status and identity conflicts', () => {
  const duplicate = v1Fixture(); duplicate.candidates.push(structuredClone(duplicate.candidates[0]!));
  expect(() => prepare(duplicate)).toThrow('v1_duplicate_map');
  for (const reason of ['PRO_STATUS_UNVERIFIED', 'MAP_CONFLICT', 'ACTUAL_ROSTER_INVALID', 'ROSTER_RECEIPT_MISMATCH', 'OUTCOME_BINDING_INVALID']) {
    const source = v1Fixture(), m = source.candidates[0]!;
    if (reason === 'PRO_STATUS_UNVERIFIED') m.isPro = null;
    if (reason === 'MAP_CONFLICT') m.ingestState = 'conflict';
    if (reason === 'ACTUAL_ROSTER_INVALID') m.players[0]!.sourceAccountId = null;
    if (reason === 'ROSTER_RECEIPT_MISMATCH') m.receiptPlayers[0]!.sourceAccountId = '10002';
    if (reason === 'OUTCOME_BINDING_INVALID' && m.outcome.status === 'verified') m.outcome.teamAWon = !m.outcome.teamAWon;
    expect(prepare(source).report.assessments[0]!.reasons).toContain(reason);
  }
  const conflict = v1Fixture(); conflict.identities.push({ ...conflict.identities[0]!, playerId: '999', observationId: 'conflicting-proof' });
  expect(prepare(conflict).report.summary.byReason.IDENTITY_CONFLICT).toBe(6);
  conflict.identities = [];
  expect(prepare(conflict).report.summary.byReason.CURRENT_IDENTITIES_UNVERIFIED).toBe(6);
});
it('keeps whole series across aliases and excludes unknown series or an out-of-window sibling', () => {
  const source = v1Fixture(); source.request.fromAt = '2024-01-02T00:00:00.000Z';
  source.aliases[1]!.providerSeriesId = source.aliases[0]!.providerSeriesId;
  expect(prepare(source).report.assessments[1]!.reasons).toContain('SERIES_OUTSIDE_WINDOW');
  source.aliases.push({ ...source.aliases[2]!, seriesId: '99999999-0000-4000-8000-000000000000', teamAId: '99' });
  expect(prepare(source).report.assessments[2]!.reasons).toContain('SERIES_ORGANIZATION_CONFLICT');
  source.candidates[3]!.seriesId = null;
  expect(prepare(source).report.assessments[3]!.reasons).toContain('SERIES_UNKNOWN');
});
it('does not silently drop a bad map from an otherwise included series', () => {
  const source = v1Fixture(); source.aliases[1]!.providerSeriesId = source.aliases[0]!.providerSeriesId;
  source.candidates[1]!.isPro = false;
  expect(prepare(source).report.assessments[0]!.reasons).toContain('SERIES_HAS_INELIGIBLE_MEMBER');
});
it('excludes later canonical state and evidence beyond the requested snapshot', () => {
  const source = v1Fixture(); source.candidates[0]!.syncedAtUs = micros('2026-11-02T00:00:00.000Z');
  expect(prepare(source).report.assessments[0]!.reasons).toContain('CANONICAL_STATE_AFTER_SNAPSHOT');
  source.identities.forEach(i => { i.fetchedAt = '2026-11-02T00:00:00.000Z'; });
  expect(prepare(source).report.summary.eligibleMaps).toBe(0);
});
it('reports zero sample without fabricating metrics or assigning folds', () => {
  const source = v1Fixture(); source.candidates = []; source.aliases = [];
  expect(prepare(source).report).toMatchObject({ status: 'unavailable', reason: 'NO_ELIGIBLE_MAPS',
    summary: { selectedMaps: 0, eligibleMaps: 0 }, teamAWinProbability: null, trainingReady: false });
});
it('does not accept synthetic data as live, truncation, caller features or invalid windows/profiles', () => {
  const source = v1Fixture(); source.syntheticOnly = false;
  expect(() => prepare(source)).toThrow('v1_synthetic_evidence_forbidden');
  source.syntheticOnly = true; source.request.maxMaps = 1;
  expect(() => prepare(source)).toThrow('v1_inventory_limit');
  const request = v1Fixture().request;
  for (const changes of [{ fromAt: request.toAt }, { snapshotAt: request.fromAt }, { profile: 'strict' },
    { purpose: 'holdout' }, { features: {} }, { maxMaps: 5001 }, { fromAt: '2024-01-01' }])
    expect(V1DataRequestSchema.safeParse({ ...request, ...changes }).success).toBe(false);
});
it('does not mistake the syntheticOnly=false flag itself for synthetic evidence', () => {
  // Synthetic test fixture with neutral provenance strings; not a live coverage claim.
  const source: V1DataSource = JSON.parse(JSON.stringify(v1Fixture(), (_key, value: unknown) =>
    typeof value === 'string' ? value.replaceAll('synthetic', 'recorded') : value));
  source.syntheticOnly = false;
  expect(prepare(source).report.summary.eligibleMaps).toBe(6);
});
