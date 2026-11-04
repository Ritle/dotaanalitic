import {expect,it} from 'vitest';
import {V1LifecycleSavedSchema} from '@dota/contracts';
import {buildV1JournalV2} from '../src/v1-journal-v2.js';
import {journalObservation as row,journalInput,journalUuid as uuid} from './v1-journal-fixtures.js';
const state=(action:'cancelled'|'reopened'='cancelled')=>V1LifecycleSavedSchema.parse({sha256:'a'.repeat(64),event:{
  format:'v1-target-lifecycle-v1',ownerId:uuid(999),target:{provider:'opendota',providerSeriesId:'321',mapNumber:1},revision:action==='cancelled'?1:2,
  previousSha256:action==='cancelled'?null:'b'.repeat(64),source:'owner_reported',recordedAt:'2026-01-02T00:00:00.000000Z',
  request:{requestId:uuid(900),predictionRequestId:uuid(1),expectedRevision:action==='cancelled'?0:1,action,eventAt:null,
    sourceUrl:'https://example.test/synthetic',reason:'Synthetic cancellation review'}}});
const input=(rows:ReturnType<typeof row>[],lifecycle=[state()])=>({...journalInput(rows),format:'v1-journal-input-v2',lifecycle});
it('counts cancelled targets once across recalculations, retains unavailable reasons and null metrics',()=>{
  const pending={binding:null,verification:null};
  const r=buildV1JournalV2(input([row(1,pending),row(2,{...pending,status:'unavailable',probability:null,issuedAt:null,attemptReasons:['NO_ACTIVE_MODEL']})]),{});
  expect(r.counts).toMatchObject({attempts:2,cancelled:1,unavailable:1,pendingVerification:0});
  expect(r.rows.map(x=>x.status)).toEqual(['cancelled','cancelled']);expect(r.metrics).toMatchObject({n:0,accuracy:null,brier:null});
  expect(buildV1JournalV2(input([row(1,pending)]),{status:'cancelled'}).counts.cancelled).toBe(1);
});
it('reopening restores pending status without manufacturing a verified map',()=>{
  const r=buildV1JournalV2(input([row(1,{binding:null,verification:null})],[state('reopened')]),{});
  expect(r.rows[0]?.status).toBe('pending_verification');expect(r.counts.cancelled).toBe(0);expect(r.metrics.n).toBe(0);
});
it('never hides losing verified outcomes or unresolved corrections behind a cancellation',()=>{
  const loser=row(1);loser.verification!.outcome!.teamAWon=false;
  const r=buildV1JournalV2(input([loser]),{});expect(r.metrics).toMatchObject({n:1,accuracy:0});expect(r.counts.cancelled).toBe(0);
  expect(r.rows[0]?.reasons).toContain('CANCELLATION_IGNORED_VERIFIED_BINDING');
  const corrected=row(1,{verification:null}),peer=row(2,{verification:null,binding:null});
  const c=buildV1JournalV2(input([corrected,peer]),{});expect(c.counts.cancelled).toBe(0);expect(c.rows[0]?.status).toBe('unlinked');
});
it('preserves global primary before filters and excludes hypothetical targets',()=>{
  const a=row(1),b=row(2,{modelId:uuid(101),issuedAt:'2026-01-01T12:00:00.000003Z'});
  const r=buildV1JournalV2(input([a,b,row(3,{purpose:'what_if_single_map',target:null,binding:null,verification:null})]),{modelId:a.modelId});
  expect(r.metrics.n).toBe(0);expect(r.globalPrimaryMaps).toBe(1);expect(r.rows.map(x=>x.status)).toEqual(['superseded','what_if']);
});
it('rejects future, unrelated and duplicate lifecycle state; handles empty current inventory',()=>{
  const s=state();s.event.recordedAt='2026-01-04T00:00:00.000000Z';
  expect(()=>buildV1JournalV2(input([row()],[s]),{})).toThrow('journal_invalid_lifecycle');
  expect(()=>buildV1JournalV2(input([], [state()]),{})).toThrow('journal_invalid_lifecycle');
  expect(()=>buildV1JournalV2(input([row()], [state(),state()]),{})).toThrow('journal_duplicate_lifecycle');
  expect(buildV1JournalV2(input([],[]),{}).counts.cancelled).toBe(0);
});
