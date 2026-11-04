import {expect,it} from 'vitest';
import {V1ScheduledLifecycleSavedSchema,V1ScheduledLifecycleCreateSchema} from '@dota/contracts';
import {buildV1JournalV3} from '../src/v1-journal-v3.js';
import {journalObservation as row,journalInput,journalUuid as uuid} from './v1-journal-fixtures.js';
const target=(n=1)=>({provider:'pandascore' as const,bindingVersion:1 as const,providerMatchId:'9007199254742999',mapNumber:1 as const,targetRequestId:uuid(700+n),targetSha256:'a'.repeat(64)});
const state=(action:'cancelled'|'reopened'='cancelled')=>V1ScheduledLifecycleSavedSchema.parse({sha256:'a'.repeat(64),event:{
  format:'v1-scheduled-lifecycle-v1',ownerId:uuid(999),target:{provider:'pandascore',providerMatchId:target().providerMatchId,mapNumber:1},revision:action==='cancelled'?1:2,
  previousSha256:action==='cancelled'?null:'b'.repeat(64),source:'owner_reported',recordedAt:'2026-01-02T00:00:00.000000Z',
  request:{requestId:uuid(900),targetRequestId:target().targetRequestId,expectedRevision:action==='cancelled'?0:1,action,eventAt:null,
    sourceUrl:'https://example.test/synthetic',reason:'Synthetic cancellation review'}}});
const input=(rows:ReturnType<typeof row>[],scheduledLifecycle=[state()],scheduledBindings:unknown[]=[])=>({...journalInput(rows),format:'v1-journal-input-v3',lifecycle:[],scheduledLifecycle,scheduledBindings});
const pending=(n=1)=>row(n,{target:target(n),binding:null,verification:null});
it('counts one cancelled meeting across schedule revisions and preserves unavailable reasons',()=>{
  const a=pending(),b=pending(2);b.status='unavailable';b.probability=null;b.issuedAt=null;b.attemptReasons=['NO_ACTIVE_MODEL'];
  const r=buildV1JournalV3(input([a,b]),{});expect(r.counts).toMatchObject({cancelled:1,unavailable:1,primaryMaps:0});
  expect(r.rows.map(x=>x.status)).toEqual(['cancelled','cancelled']);expect(r.rows[1]?.reasons).toContain('NO_ACTIVE_MODEL');expect(r.metrics.accuracy).toBeNull();
  expect(buildV1JournalV3(input([a,b]),{status:'cancelled'}).counts.attempts).toBe(2);
});
it('supports cancellation before any forecasts and reopens without creating an outcome',()=>{
  expect(buildV1JournalV3(input([]),{}).counts).toMatchObject({attempts:0,cancelled:0});
  const r=buildV1JournalV3(input([pending()],[state('reopened')]),{});expect(r.rows[0]?.status).toBe('pending_verification');expect(r.metrics.n).toBe(0);
});
it('does not hide a verified map binding even before its first outcome refresh',()=>{
  const proof={providerMatchId:target().providerMatchId,matchId:'123',requestId:uuid(888),sha256:'b'.repeat(64),reviewedAt:'2026-01-02T12:00:00.000000Z'};
  const r=buildV1JournalV3(input([pending()],[state()],[proof]),{});
  expect(r.counts.cancelled).toBe(0);expect(r.rows[0]?.status).toBe('pending_verification');expect(r.rows[0]?.reasons).toContain('CANCELLATION_IGNORED_VERIFIED_BINDING');
  expect(r.metrics.n).toBe(0); // A binding receipt is not itself a new verified scoring outcome.
});
it('preserves losing outcomes, global primary selection, and unresolved corrections across revisions',()=>{
  const a=row(1,{target:target()}),b=row(2,{target:target(2),modelId:uuid(101),issuedAt:'2026-01-01T12:00:00.000003Z'});
  a.verification!.outcome!.teamAWon=false;b.verification!.outcome!.teamAWon=false;
  const r=buildV1JournalV3(input([a,b]),{});expect(r.metrics).toMatchObject({n:1,accuracy:0});expect(r.counts.cancelled).toBe(0);
  expect(buildV1JournalV3(input([a,b]),{modelId:a.modelId}).metrics.n).toBe(0);
  a.verification=null;expect(buildV1JournalV3(input([a,pending(3)]),{}).counts.cancelled).toBe(0);
});
it('rejects duplicate and future lifecycle/binding evidence and never cancels what-if',()=>{
  const s=state();s.event.recordedAt='2026-01-04T00:00:00.000000Z';expect(()=>buildV1JournalV3(input([],[s]),{})).toThrow('journal_invalid_lifecycle');
  expect(()=>buildV1JournalV3(input([],[state(),state()]),{})).toThrow('journal_duplicate_lifecycle');
  const b={providerMatchId:target().providerMatchId,matchId:'123',requestId:uuid(888),sha256:'b'.repeat(64),reviewedAt:'2026-01-04T00:00:00.000000Z'};
  expect(()=>buildV1JournalV3(input([],[],[b]),{})).toThrow('journal_future_scheduled_binding');
  expect(()=>buildV1JournalV3(input([],[],[b,b]),{})).toThrow('journal_duplicate_scheduled_binding');
  expect(buildV1JournalV3(input([row(1,{purpose:'what_if_single_map',target:null,binding:null,verification:null})]),{}).rows[0]?.status).toBe('what_if');
});
it('requires owner confirmation and forbids user control of source identity, winner or recording clock',()=>{
  const {targetRequestId:_,...request}=state().event.request,body={...request,confirmedByOwner:true};
  expect(V1ScheduledLifecycleCreateSchema.parse(body)).toEqual(body);
  for(const patch of [{confirmedByOwner:false},{targetRequestId:uuid(1)},{recordedAt:'2000-01-01T00:00:00.000000Z'},{winner:'A'}])
    expect(V1ScheduledLifecycleCreateSchema.safeParse({...body,...patch}).success).toBe(false);
});
