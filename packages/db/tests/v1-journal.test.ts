import {expect,it} from 'vitest';
import {buildV1Journal} from '../src/v1-journal.js';
import {journalObservation as row,journalInput as input,journalUuid as uuid} from './v1-journal-fixtures.js';
it('reports unknown cancellation and nullable metrics for an empty journal',()=>{
  expect(buildV1Journal(input([]),{})).toMatchObject({counts:{attempts:0,primaryMaps:0,cancelled:null},metrics:{n:0,accuracy:null,brier:null,logLoss:null}});
});
it('chooses the last issued forecast even when its probability is worse',()=>{
  const old=row(1,{probability:0.9}),next=row(2,{probability:0.1,issuedAt:'2026-01-01T12:00:00.000003Z'});
  const r=buildV1Journal(input([next,old]),{});expect(r.rows.find(x=>x.predictionId===next.id)?.status).toBe('primary');
  expect(r.metrics).toMatchObject({n:1,accuracy:0,brier:0.81});expect(r.counts).toMatchObject({attempts:2,superseded:1,primaryMaps:1});
});
it('uses full microseconds then created time then canonical UUID, independently of input order',()=>{
  const a=row(1),b=row(2,{issuedAt:a.issuedAt,createdAt:'2026-01-01T12:00:00.000002Z'}),c=row(3,{...b,id:uuid(3),requestId:uuid(3),verification:row(3).verification});
  for(const values of [[a,b,c],[c,a,b]])expect(buildV1Journal(input(values),{}).rows.find(x=>x.status==='primary')?.predictionId).toBe(c.id);
});
it('never promotes an earlier model or earlier period forecast after filtering',()=>{
  const a=row(1),b=row(2,{modelId:uuid(101),createdAt:'2026-01-01T13:00:00.000001Z',issuedAt:'2026-01-01T13:00:00.000002Z'});
  const byModel=buildV1Journal(input([a,b]),{modelId:a.modelId}),byPeriod=buildV1Journal(input([a,b]),{until:'2026-01-01T13:00:00.000Z'});
  for(const r of [byModel,byPeriod]){expect(r.metrics.n).toBe(0);expect(r.rows[0]?.status).toBe('superseded');expect(r.globalPrimaryMaps).toBe(1);}
});
it('does not replace a mismatched or unknown primary with an earlier matched lineup',()=>{
  for(const rosterStatus of ['mismatched','unknown'] as const){const a=row(1),b=row(2,{issuedAt:'2026-01-01T12:00:00.000003Z'});b.verification!.rosterStatus=rosterStatus;
    const r=buildV1Journal(input([a,b]),{});expect(r.metrics.n).toBe(1);expect(r.matchedLineupMetrics.n).toBe(0);}
});
it('keeps what-if, unavailable, pending, conflict and late forecasts in audit but out of metrics',()=>{
  const values=[row(1,{purpose:'what_if_single_map',target:null,binding:null,verification:null}),row(2,{status:'unavailable',probability:null,issuedAt:null}),
    row(3,{binding:null,verification:null}),row(4,{bindingConflict:true}),row(5,{issuedAt:'2026-01-02T00:00:00.000000Z'})];
  const r=buildV1Journal(input(values),{});expect(r.metrics.n).toBe(0);
  expect(r.rows.map(x=>x.status)).toEqual(['what_if','unavailable','pending_verification','unlinked','excluded']);
});
it('allows cutoff equal to start but requires strictly earlier creation and issuance',()=>{
  const a=row(1,{cutoffAt:'2026-01-02T00:00:00.000Z',issuedAt:'2026-01-01T23:59:59.999999Z'});
  expect(buildV1Journal(input([a]),{}).metrics.n).toBe(1);
  for(const patch of [{createdAt:'2026-01-02T00:00:00.000000Z'},{issuedAt:'2026-01-02T00:00:00.000000Z'},
    {cutoffAt:'2026-01-02T00:00:00.001Z'},{eligibleModelAtIssuance:false}])expect(buildV1Journal(input([row(1,patch)]),{}).metrics.n).toBe(0);
});
it('deduplicates one actual map across A/B swaps and computes the selected orientation',()=>{
  const a=row(1),b=row(2,{probability:0.3,teamAId:'22',teamBId:'11'});b.verification!.teamASide='dire';
  Object.assign(b.verification!.outcome!,{teamAId:'22',teamBId:'11',teamAWon:false});
  const r=buildV1Journal(input([a,b]),{});expect(r.metrics).toMatchObject({n:1,accuracy:1});expect(r.metrics.brier).toBeCloseTo(0.09);
});
it('refuses duplicate observations, mismatched bindings and inconsistent current truths',()=>{
  const a=row(1);expect(()=>buildV1Journal(input([a,a]),{})).toThrow('journal_duplicate_prediction');
  const b=row(2);b.verification!.predictionId=a.id;expect(()=>buildV1Journal(input([b]),{})).toThrow('journal_verification_binding');
  const c=row(3);c.verification!.outcome!.teamAWon=false;
  expect(()=>buildV1Journal(input([a,c]),{})).toThrow('journal_inconsistent_current_outcomes');
});
