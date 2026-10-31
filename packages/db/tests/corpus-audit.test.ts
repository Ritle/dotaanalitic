// Synthetic captures exercise format/diagnostics only; never historical evidence or a training set.
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { auditCorpusCaptures, type CorpusCapture } from '../src/corpus-audit.js';
import type { DatasetBuildRequest } from '@dota/contracts';
const stamp='2026-10-30T00:00:00.000Z';
const request:DatasetBuildRequest={stage:'pre_match',teamASide:'radiant',fromAt:'2016-01-01T00:00:00.000Z',
  trainUntil:'2020-01-01T00:00:00.000Z',calibrationUntil:'2021-01-01T00:00:00.000Z',
  validationUntil:'2022-01-01T00:00:00.000Z',toAt:'2026-01-01T00:00:00.000Z',snapshotAt:'2026-10-31T00:00:00.000Z',maxMaps:1000};
const evidence={endpoint:'/synthetic',fetched_at:stamp,payload_sha256:'a'.repeat(64),adapter_version:'synthetic-fixture'};
const row=(match_id='9007199254740993',series_id:string|null='1',start='2018-01-01T00:00:00.000Z')=>({
  match_id,start_time:Date.parse(start)/1000,duration:1800,radiant_win:true,radiant_team_id:'11',dire_team_id:'22',
  leagueid:'77',series_id,series_type:1});
const capture=(kind:CorpusCapture['kind'],body:unknown):CorpusCapture=>{
  const content=JSON.stringify(body);return {kind,content,sha256:createHash('sha256').update(content).digest('hex')};
};
const discovery=(matches:ReturnType<typeof row>[],overrides:Record<string,unknown>={})=>capture('discovery',{
  schema_version:1,mode:'live_opendota',generated_at:stamp,selection_catalog:{source_evidence:evidence},
  cohorts:[{league_id:'77',name:'Synthetic League',tier:'professional',endpoint_completeness:'unknown',
    series_membership_completeness:'unknown',source_evidence:evidence,matches}],errors:[],...overrides});
const details=(id='9007199254740993',overrides:Record<string,unknown>={})=>capture('details',{
  schema_version:3,mode:'live_opendota',generated_at:stamp,status:'complete',source_evidence:[evidence],observations:[{
    match_id:id,started_at:'2018-01-01T00:00:00.000Z',league_id:'77',provider_patch_id:7,
    flags:{confirmed_pro:true,match_id_consistent:true,completed_outcome:true,identity_10:true,heroes_10_unique:true,
      pre_match_lineup_known_at:null,verified_patch:null},source_evidence:evidence}],...overrides});

it('counts one canonical map across captures and keeps discovery context distinct from detailed coverage',()=>{
  const report=auditCorpusCaptures([discovery([row()]),details()],request);
  expect(report).toMatchObject({uniqueMaps:1,observations:2,repeatedObservations:1,discoveryMaps:1,detailedMaps:1,
    bySplit:{train:1},strictHistoricalEligibility:'not_assessed',trainingReady:false,deployable:false});
  expect(report.maps[0]!.matchId).toBe('9007199254740993');
  expect(report.detailCoverage.identity_10).toEqual({passed:1,assessed:1,unassessed:0,ratio:1});
  expect(report.detailCoverage.series).toEqual({passed:0,assessed:0,unassessed:1,ratio:null});
  expect(report.remoteCorpusCompleteness).toBe('unknown');
});
it('deduplicates identical captures and is invariant to capture list ordering',()=>{
  const a=discovery([row()]),b=details();
  expect(auditCorpusCaptures([b,a],request)).toEqual(auditCorpusCaptures([a,b],request));
  expect(auditCorpusCaptures([a,a,b],request)).toMatchObject({uniqueMaps:1,observations:2,duplicateCaptures:1});
});
it('repeated detailed observations do not inflate metric sample size',()=>{
  const report=auditCorpusCaptures([details(),details(undefined,{generated_at:'2026-10-30T01:00:00.000Z'})],request);
  expect(report).toMatchObject({uniqueMaps:1,detailedMaps:1,observations:2});
  expect(report.detailCoverage.identity_10.assessed).toBe(1);
  expect(report.maps[0]!.discoverySplit).toBeNull();
  expect(report.maps[0]!.reasons).toContain('DISCOVERY_OUTCOME_UNCONFIRMED');
});
it('rejects conflicting capture kinds for the same bytes regardless of reference order',()=>{
  const a=discovery([row()]),wrong={...a,kind:'details' as const};
  for(const captures of [[a,wrong],[wrong,a]]) expect(()=>auditCorpusCaptures(captures,request)).toThrow();
});
it('retains conflicting source winners and quarantines every observed member of that series',()=>{
  const a=row(),b=row('2');
  const report=auditCorpusCaptures([discovery([a,b]),discovery([{...a,radiant_win:false}])],request);
  expect(report.conflictingMaps).toBe(1); expect(report.quarantinedSourceSeries).toEqual(['1']);
  expect(report.maps.every(r=>r.discoverySplit===null && r.reasons.includes('SERIES_SOURCE_CONFLICT'))).toBe(true);
  expect(report.maps.find(r=>r.matchId===a.match_id)!.conflictFields).toContain('radiantWon');
});
it('conflicting participants for a source series cannot become independent observations in separate folds',()=>{
  const report=auditCorpusCaptures([discovery([row(),{...row('2','1','2022-01-01T00:00:00.000Z'),dire_team_id:'33'}])],request);
  expect(report.quarantinedSourceSeries).toEqual(['1']);
  expect(report.bySplit).toEqual({});
});
it('uses whole observed series across all window boundaries including outside-window members',()=>{
  const report=auditCorpusCaptures([discovery([row('1','1'),row('2','1',request.trainUntil),row('3','2'),
    row('4','2','2015-12-31T00:00:00.000Z'),row('5',null)])],request);
  expect(report.bySplit).toEqual({});
  expect(report.byReason).toMatchObject({SERIES_CROSSES_SPLIT:2,SERIES_OUTSIDE_WINDOW:1,OUTSIDE_WINDOW:1,SERIES_UNKNOWN:1});
});
it('unknown values and empty samples remain null rather than a measured zero coverage rate',()=>{
  const report=auditCorpusCaptures([discovery([])],request);
  expect(report.status).toBe('unavailable');expect(report.uniqueMaps).toBe(0);
  expect(report.detailCoverage.identity_10.ratio).toBeNull();
  const unknown=discovery([{...row(),duration:0}]);
  expect(auditCorpusCaptures([unknown],request).maps[0]!.reasons).toContain('DISCOVERY_OUTCOME_UNCONFIRMED');
});
it('rejects tampered bytes, unsupported synthetic/legacy report modes and captures after the horizon',()=>{
  const good=discovery([row()]);
  expect(()=>auditCorpusCaptures([{...good,content:good.content+' '}],request)).toThrow('capture_sha_mismatch');
  expect(()=>auditCorpusCaptures([discovery([],{mode:'synthetic_fixture'})],request)).toThrow();
  expect(()=>auditCorpusCaptures([details(undefined,{schema_version:2})],request)).toThrow();
  expect(()=>auditCorpusCaptures([discovery([],{generated_at:'2026-11-01T00:00:00.000Z'})],request)).toThrow('capture_after_snapshot');
});
it('changing source content changes the report fingerprint without mutating the old report',()=>{
  const first=auditCorpusCaptures([discovery([row()])],request),saved=JSON.stringify(first);
  const second=auditCorpusCaptures([discovery([{...row(),radiant_win:false}])],request);
  expect(second.fingerprint).not.toBe(first.fingerprint);expect(JSON.stringify(first)).toBe(saved);
});
it('reports partial captures and date/league/provider-patch strata without claiming verified patches',()=>{
  const report=auditCorpusCaptures([discovery([row()]),details(undefined,{status:'partial'})],request);
  expect(report.status).toBe('partial');expect(report.captureErrors).toBe(1);
  expect(report.strata.year[0]).toMatchObject({value:'2018',maps:1,detailedMaps:1});
  expect(report.strata.providerPatch[0]).toMatchObject({value:'7',maps:1});
  expect(report.strictHistoricalEligibility).toBe('not_assessed');
});
