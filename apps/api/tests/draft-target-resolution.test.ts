import {test,expect} from 'vitest';
import {registryHash,registrySha} from '../../../packages/db/src/index.js';
import {draftTargetFixture} from '../../../tests/helpers/draft-target.js';
import {resolveDraftTargets} from '../src/modules/scenarios/draft-target-resolution.js';
const result=(s:ReturnType<typeof draftTargetFixture>)=>resolveDraftTargets(s).items[0]!;
const rehash=(s:ReturnType<typeof draftTargetFixture>)=>{const c=s.items[0]!.capture;c.sha256=registrySha(JSON.stringify(c.snapshot));};

test('matches stable IDs and the second map, but never claims verified pregame timing or eligibility',()=>{
  const s=draftTargetFixture(),before=JSON.stringify(s),r=result(s);
  expect(r).toMatchObject({bindingStatus:'matched',actualMatchId:'9007199254740995',teamASide:'radiant',
    temporalStatus:'before_provider_start_semantics_unverified',prestartVerified:false,primaryEligible:false,deployable:false});
  expect(r.reasons).toContain('ACTUAL_GAMEPLAY_START_SEMANTICS_UNVERIFIED');expect(JSON.stringify(s)).toBe(before);
});
test('matches reversed Radiant/Dire and shuffled transport rows without treating role as player slot',()=>{
  const s=draftTargetFixture(),m=s.items[0]!.candidates[0]!;
  [m.radiantTeamId,m.direTeamId]=[m.direTeamId,m.radiantTeamId];m.players.forEach(p=>{p.slot=p.slot<128?p.slot+128:p.slot-128;});
  m.receipt!.projection.players=m.players.map(p=>({account_id:p.accountId,hero_id:p.heroId,player_slot:p.slot})).reverse();m.players.reverse();
  expect(result(s)).toMatchObject({bindingStatus:'matched',teamASide:'dire'});
});
test('strict microsecond cutoff: equality and a late persistence never pass before-provider-start',()=>{
  for(const at of ['2026-01-01T12:00:00.000000Z','2026-01-01T12:00:00.000001Z']){
    const s=draftTargetFixture();s.items[0]!.capture.recordedAt=at;
    expect(result(s)).toMatchObject({bindingStatus:'matched',temporalStatus:'not_before_provider_start',prestartVerified:false});
  }
});
test('organization names, matching five and a coincident numeric ID cannot bridge provider namespaces',()=>{
  const s=draftTargetFixture();s.items[0]!.capture.snapshot.target!.provider='pandascore';rehash(s);
  expect(result(s).ledger[0]!.reasons).toContain('PROVIDER_SERIES_MAPPING_UNVERIFIED');expect(result(s).actualMatchId).toBeNull();
});
test('missing, unreviewed, future or conflicting ordinal does not fall back to chronological order',()=>{
  for(const variant of ['missing','unreviewed','future','conflict','wrong'] as const){
    const s=draftTargetFixture(),m=s.items[0]!.candidates[0]!,o=m.ordinals[0]!;
    if(variant==='missing')m.ordinals=[];
    if(variant==='unreviewed')o.reviewState='unverified';
    if(variant==='future')o.recordedAtUs='999999999999999999';
    if(variant==='conflict')m.ordinals.push({...o,id:'2',value:3,valueSha256:registryHash(3)});
    if(variant==='wrong'){o.value=1;o.valueSha256=registryHash(1);}
    expect(result(s).actualMatchId,variant).toBeNull();
  }
});
test('wrong hero/account/side, duplicate slot and incomplete actual players fail closed',()=>{
  for(const variant of ['hero','account','side','slot','missing'] as const){
    const s=draftTargetFixture(),m=s.items[0]!.candidates[0]!;
    if(variant==='hero')m.players[0]!.heroId=99;
    if(variant==='account')m.players[0]!.accountId='999';
    if(variant==='side')m.players[0]!.slot=128;
    if(variant==='slot')m.players[0]!.slot=1;
    if(variant==='missing')m.players.pop();
    expect(result(s).actualMatchId,variant).toBeNull();
  }
});
test('receipt source mismatch and unverified pro outcome reject a matching canonical map',()=>{
  for(const variant of ['id','series','start','players','pro','receipt'] as const){
    const s=draftTargetFixture(),m=s.items[0]!.candidates[0]!;
    if(variant==='id')m.receipt!.projection.match_id='9';
    if(variant==='series')m.receipt!.projection.series_id='8';
    if(variant==='start')m.receipt!.projection.start_time=1;
    if(variant==='players')m.receipt!.projection.players=[];
    if(variant==='pro')m.outcome.verified=false;
    if(variant==='receipt')m.outcome.receiptId='3';
    expect(result(s).actualMatchId,variant).toBeNull();
  }
});
test('two qualifying maps remain ambiguous; duplicate map rows are not independent observations',()=>{
  const s=draftTargetFixture(),m=structuredClone(s.items[0]!.candidates[0]!);m.matchId='9007199254740998';m.receipt!.providerMatchId=m.matchId;m.receipt!.projection.match_id=m.matchId;
  s.items[0]!.candidates.push(m);expect(result(s)).toMatchObject({actualMatchId:null,reasons:['AMBIGUOUS_MAP']});
  s.items[0]!.candidates.push(m);expect(()=>result(s)).toThrow('duplicate_candidate_map');
});
test('tampered capture is rejected and malformed timestamp/bigint does not coerce',()=>{
  const s=draftTargetFixture();s.items[0]!.capture.snapshot.players[0]!.heroId=99;expect(()=>result(s)).toThrow('capture_hash_mismatch');
  const t=draftTargetFixture();t.items[0]!.candidates[0]!.startedAtUs='1.5';expect(()=>result(t)).toThrow();
});
test('empty local inventory and missing target are explicit, never a fabricated map',()=>{
  const s=draftTargetFixture();s.items[0]!.candidates=[];expect(result(s).reasons).toEqual(['NO_LOCAL_CANDIDATES']);
  s.items[0]!.capture.snapshot.target=null;rehash(s);expect(result(s).reasons).toContain('TARGET_REFERENCE_MISSING');
  s.items=[];expect(resolveDraftTargets(s)).toMatchObject({matched:0,items:[],prestartVerified:0});
});
