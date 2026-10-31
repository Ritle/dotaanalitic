import { expect, it } from 'vitest';
import { DatasetFeaturesSchema, DatasetManifestSchema, DatasetMapInputSchema } from '@dota/contracts';

it('preserves nullable features and zero without inventing an estimate', () => {
  expect(DatasetFeaturesSchema.parse({ prior_map_count: 0, prior_win_rate: null })).toEqual({ prior_map_count: 0, prior_win_rate: null });
});
it.each(['label','radiant_win','team_a_won','probability','prediction_run_id'])('rejects reserved %s input', key => {
  expect(() => DatasetFeaturesSchema.parse({ [key]: 1 })).toThrow();
});
it('rejects nested values, non-finite features and implicit target labels in persistence input', () => {
  for (const value of [Infinity, NaN, { value: 1 }, true, [1]]) expect(() => DatasetFeaturesSchema.parse({ feature: value })).toThrow();
  const row = { datasetId: '123e4567-e89b-42d3-a456-426614174000', matchId: '9007199254740993', outcomeReceiptId: '1',
    teamAId: '11', teamBId: '22', cutoffAt: '2024-01-01T12:00:00.000Z', split: 'train', features: { prior_games: 0 } };
  expect(DatasetMapInputSchema.parse(row).matchId).toBe('9007199254740993');
  expect(() => DatasetMapInputSchema.parse({ ...row, teamAWon: true })).toThrow();
  expect(() => DatasetMapInputSchema.parse({ ...row, predictionRunId: '1' })).toThrow();
  expect(() => DatasetMapInputSchema.parse({ ...row, teamBId: '11' })).toThrow();
});
it('does not accept unversioned or prediction-derived label policies', () => {
  expect(() => DatasetManifestSchema.parse({ stage: 'pre_match', featureSchemaVersion: 'v1', labelPolicyVersion: 'model_probability',
    cutoffPolicyVersion: 'v1', patchRegistryRevision: '0', dataRevision: '1', codeRevision: 'test', splitPolicy: {}, sourceManifest: {} })).toThrow();
});
