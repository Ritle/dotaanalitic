import { expect, it } from 'vitest';
import { assessProviderSeriesAliases, assignDatasetSplits, providerSeriesKey, type ProviderSeriesAlias } from '../src/dataset-splits.js';
import type { DatasetBuildRequest } from '@dota/contracts';
const alias=(seriesId:string,teamAId:string|null='11',teamBId:string|null='22',provider='opendota',providerSeriesId='901'):ProviderSeriesAlias=>
  ({seriesId,teamAId,teamBId,provider,providerSeriesId});
const request:DatasetBuildRequest={stage:'pre_match',teamASide:'radiant',fromAt:'2024-01-01T00:00:00.000Z',
  trainUntil:'2024-01-02T00:00:00.000Z',calibrationUntil:'2024-01-03T00:00:00.000Z',validationUntil:'2024-01-04T00:00:00.000Z',
  toAt:'2024-01-05T00:00:00.000Z',snapshotAt:'2026-10-31T20:00:00.000Z',maxMaps:100};
it('uses exact provider-scoped positive IDs, without normalization of unknown or malformed values',()=>{
  expect(providerSeriesKey('opendota','9007199254740993')).toBe('opendota:9007199254740993');
  expect(providerSeriesKey('stratz','901')).toBe('stratz:901');
  for(const id of [null,'0','01','-1','1.0','9223372036854775808']) expect(providerSeriesKey('opendota',id)).toBeNull();
  for(const provider of [null,'','OpenDota','opendota:other']) expect(providerSeriesKey(provider,'901')).toBeNull();
});
it('preserves canonical aliases, recognizes unordered organization pairs and ignores input row order',()=>{
  const aliases=[alias('b','22','11'),alias('a')];
  const expected=assessProviderSeriesAliases(aliases);
  expect(expected.map(row=>row.seriesId)).toEqual(['a','b']);
  expect(expected.every(row=>!row.seriesConflict && row.seriesOrganizationsKnown)).toBe(true);
  expect(assessProviderSeriesAliases([...aliases].reverse())).toEqual(expected);
  expect(()=>assessProviderSeriesAliases([alias('a'),alias('a')])).toThrow('duplicate_series_alias');
});
it('propagates contradictory organization pairs to the whole provider group, separately from unknown metadata',()=>{
  const conflicting=assessProviderSeriesAliases([alias('a'),alias('b','11','33')]);
  expect(conflicting.every(row=>row.seriesConflict && !row.seriesOrganizationsKnown)).toBe(true);
  const unknown=assessProviderSeriesAliases([alias('a'),alias('b',null,'22')]);
  expect(unknown.every(row=>!row.seriesConflict && !row.seriesOrganizationsKnown)).toBe(true);
  const scoped=assessProviderSeriesAliases([alias('a'),alias('b','11','33','stratz')]);
  expect(scoped.every(row=>!row.seriesConflict && row.seriesOrganizationsKnown)).toBe(true);
});
it('uses provider aliases for whole-series split exclusions, with explicit organization reasons',()=>{
  const rows=assessProviderSeriesAliases([alias('a'),alias('b')]);
  const members=rows.map((row,i)=>({...row,matchId:String(i+1),startedAt:i?request.validationUntil:request.fromAt}));
  expect(assignDatasetSplits(members,request).map(row=>row.reason)).toEqual(['SERIES_CROSSES_SPLIT','SERIES_CROSSES_SPLIT']);
  const conflicted=assessProviderSeriesAliases([alias('a'),alias('b','11','33')]);
  expect(assignDatasetSplits(conflicted.map((row,i)=>({...row,matchId:String(i+1),startedAt:request.fromAt})),request)
    .every(row=>row.reason==='SERIES_ORGANIZATION_CONFLICT')).toBe(true);
  const unknown=assessProviderSeriesAliases([alias('a'),alias('b',null,'22')]);
  expect(assignDatasetSplits(unknown.map((row,i)=>({...row,matchId:String(i+1),startedAt:request.fromAt})),request)
    .every(row=>row.reason==='SERIES_ORGANIZATIONS_UNKNOWN')).toBe(true);
});
