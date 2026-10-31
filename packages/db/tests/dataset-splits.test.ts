import { expect, it } from 'vitest';
import { DatasetBuildRequestSchema, type DatasetBuildRequest } from '@dota/contracts';
import { assignDatasetSplits, type SplitMember } from '../src/dataset-splits.js';

const request: DatasetBuildRequest = {
  stage: 'pre_match', teamASide: 'radiant', fromAt: '2024-01-01T00:00:00.000Z',
  trainUntil: '2024-01-10T00:00:00.000Z', calibrationUntil: '2024-01-20T00:00:00.000Z',
  validationUntil: '2024-01-25T00:00:00.000Z', toAt: '2024-02-01T00:00:00.000Z',
  snapshotAt: '2024-03-01T00:00:00.000Z', maxMaps: 1000
};
const member = (matchId: string, startedAt: string, seriesId: string | null = matchId): SplitMember => ({ matchId, startedAt, seriesId });

it('assigns exact UTC boundaries to the next split and excludes the upper selection bound', () => {
  const rows = assignDatasetSplits([
    member('1', '2023-12-31T23:59:59.999Z'), member('2', request.fromAt),
    member('3', '2024-01-09T23:59:59.999Z'), member('4', request.trainUntil),
    member('5', request.calibrationUntil), member('6', request.validationUntil),
    member('7', '2024-01-31T23:59:59.999Z'), member('8', request.toAt)
  ], request);
  expect(rows.map(({ matchId, split, reason }) => ({ matchId, split, reason }))).toEqual([
    { matchId: '2', split: 'train', reason: null }, { matchId: '3', split: 'train', reason: null },
    { matchId: '4', split: 'calibration', reason: null }, { matchId: '5', split: 'validation', reason: null },
    { matchId: '6', split: 'test', reason: null }, { matchId: '7', split: 'test', reason: null }
  ]);
});

it('keeps maps in a known series together without combining them into one observation', () => {
  const rows = assignDatasetSplits([
    member('9007199254740993', '2024-01-03T11:00:00.000Z', 'series-a'),
    member('9007199254740994', '2024-01-03T12:00:00.000Z', 'series-a')
  ], request);
  expect(rows.map(row => row.matchId)).toEqual(['9007199254740993', '9007199254740994']);
  expect(rows.map(row => [row.split, row.reason])).toEqual([['train', null], ['train', null]]);
});

it('excludes unknown series without treating each unknown map as a safe independent group', () => {
  const rows = assignDatasetSplits([
    member('1', request.fromAt, null), member('2', request.validationUntil, null)
  ], request);
  expect(rows.map(row => [row.split, row.reason])).toEqual([
    [null, 'SERIES_UNKNOWN'], [null, 'SERIES_UNKNOWN']
  ]);
});

it('excludes every map of a series crossing any chronological split boundary', () => {
  const rows = assignDatasetSplits([
    member('1', '2024-01-09T23:59:59.999Z', 'series-a'), member('2', request.trainUntil, 'series-a'),
    member('3', '2024-01-19T23:59:59.999Z', 'series-b'), member('4', request.calibrationUntil, 'series-b'),
    member('5', '2024-01-24T23:59:59.999Z', 'series-c'), member('6', request.validationUntil, 'series-c')
  ], request);
  expect(rows).toHaveLength(6);
  expect(rows.every(row => row.split === null && row.reason === 'SERIES_CROSSES_SPLIT')).toBe(true);
});

it('uses locally known members outside the window to reject incomplete series selection', () => {
  const rows = assignDatasetSplits([
    member('1', '2023-12-31T23:59:59.999Z', 'series-a'), member('2', request.fromAt, 'series-a'),
    member('3', '2024-01-31T23:59:59.999Z', 'series-b'), member('4', request.toAt, 'series-b'),
    member('5', request.fromAt, 'series-c')
  ], request);
  expect(rows.map(row => [row.matchId, row.split, row.reason])).toEqual([
    ['2', null, 'SERIES_OUTSIDE_WINDOW'], ['3', null, 'SERIES_OUTSIDE_WINDOW'], ['5', 'train', null]
  ]);
});

it('rejects repeated canonical IDs even when the repeated row is outside the selection window', () => {
  for (const other of [request.fromAt, request.toAt]) {
    expect(() => assignDatasetSplits([member('1', request.fromAt), member('1', other)], request))
      .toThrow('duplicate_split_map');
  }
});

it('gives identical per-map decisions regardless of member input order', () => {
  const members = [member('1', request.fromAt, 'series-a'), member('2', request.trainUntil, 'series-a'),
    member('3', request.calibrationUntil), member('4', request.validationUntil, null),
    member('5', request.fromAt, 'series-b'), member('6', request.toAt, 'series-b')];
  const decisions = (rows: readonly SplitMember[]) => assignDatasetSplits(rows, request)
    .sort((a, b) => a.matchId.localeCompare(b.matchId));
  expect(decisions([...members].reverse())).toEqual(decisions(members));
  expect(decisions([...members.slice(3), ...members.slice(0, 3)])).toEqual(decisions(members));
});

it('requires valid millisecond UTC dates and strictly increasing split boundaries', () => {
  for (const snapshotAt of ['2024-02-30T00:00:00.000Z', '2024-03-01T00:00:00Z', '2024-03-01T03:00:00.000+03:00']) {
    expect(DatasetBuildRequestSchema.safeParse({ ...request, snapshotAt }).success).toBe(false);
  }
  for (const change of [
    { trainUntil: request.fromAt }, { calibrationUntil: request.trainUntil },
    { validationUntil: request.calibrationUntil }, { toAt: request.validationUntil },
    { fromAt: request.toAt }, { snapshotAt: '2024-01-31T23:59:59.999Z' }
  ]) expect(DatasetBuildRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  expect(DatasetBuildRequestSchema.parse({ ...request, snapshotAt: request.toAt }).snapshotAt).toBe(request.toAt);
});

it('refuses caller-provided features, labels, assumptions and synthetic bypass modes', () => {
  for (const field of [{ features: {} }, { teamAWon: true }, { assumptions: ['lineup'] }, { synthetic: true },
    { cohort: 'conditional_lineup_reconstructed' }, { teamASide: 'unknown' }, { stage: 'live' }]) {
    expect(DatasetBuildRequestSchema.safeParse({ ...request, ...field }).success).toBe(false);
  }
  for (const maxMaps of [0, 5001, 1.5]) expect(DatasetBuildRequestSchema.safeParse({ ...request, maxMaps }).success).toBe(false);
  const { maxMaps: _maxMaps, ...withoutLimit } = request;
  expect(DatasetBuildRequestSchema.parse(withoutLimit).maxMaps).toBe(1000);
});
