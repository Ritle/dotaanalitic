import {test,expect} from 'vitest';
import {draftTargetFixture} from '../../../tests/helpers/draft-target.js';
import {registrySha} from '@dota/db';
import {verifyNativeDraft} from '../src/modules/scenarios/draft-native-verify.js';
import {DraftNativeRequestSchema} from '../src/modules/scenarios/draft-native-contract.js';
function fixture(){const s=draftTargetFixture(),item=s.items[0]!;return {capture:item.capture,candidate:item.candidates[0]!,matchId:item.candidates[0]!.matchId,inspectedAt:s.inspectedAt};}
const rehash=(s:ReturnType<typeof fixture>)=>{s.capture.sha256=registrySha(JSON.stringify(s.capture.snapshot));};
test('native ID verifies without provider mapping/ordinal, historical feature eligibility or probabilities',()=>{
  const s=fixture();s.capture.snapshot.target=null;rehash(s);s.candidate.series=null;s.candidate.mapNumber=null;s.candidate.ordinals=[];
  const r=verifyNativeDraft(s);expect(r).toMatchObject({status:'verified',matchId:s.matchId,teamASide:'radiant',
    temporalStatus:'before_provider_start_semantics_unverified',scheduleMappingVerified:false,mapOrdinalVerified:false,prestartVerified:false,primaryEligible:false,deployable:false});
  expect(r).not.toHaveProperty('teamAWinProbability');
});
test('source slot ordering is irrelevant; sides may be reversed',()=>{
  const s=fixture();[s.candidate.radiantTeamId,s.candidate.direTeamId]=[s.candidate.direTeamId,s.candidate.radiantTeamId];
  s.candidate.players.forEach(p=>{p.slot=p.slot<128?p.slot+128:p.slot-128;});
  (s.candidate.receipt!.projection.players as {player_slot:number}[]).forEach(p=>{p.player_slot=p.player_slot<128?p.player_slot+128:p.player_slot-128;});
  s.candidate.players.reverse();expect(verifyNativeDraft(s)).toMatchObject({status:'verified',teamASide:'dire'});
});
test('equal and later microsecond capture times never pass pre-start',()=>{
  const s=fixture();s.capture.recordedAt='2026-01-01T12:00:00.000000Z';
  expect(verifyNativeDraft(s).temporalStatus).toBe('not_before_provider_start');
  s.capture.recordedAt='2026-01-01T12:00:00.000001Z';expect(verifyNativeDraft(s).prestartVerified).toBe(false);
});
test('missing local map yields an explicit unavailable result',()=>{
  const s=fixture();expect(verifyNativeDraft({...s,candidate:null})).toMatchObject({status:'unavailable',reasons:['LOCAL_MAP_MISSING']});
});
test('pro classification, outcome evidence and receipt ownership are required',()=>{
  for(const alter of [(s:ReturnType<typeof fixture>)=>{s.candidate.isPro=null;},
    (s:ReturnType<typeof fixture>)=>{s.candidate.outcome.verified=false;},
    (s:ReturnType<typeof fixture>)=>{s.candidate.receipt!.providerMatchId='123';},
    (s:ReturnType<typeof fixture>)=>{s.candidate.receipt!.fetchedAtUs='9999999999999999999';}]){
    const s=fixture();alter(s);expect(verifyNativeDraft(s).status).toBe('unavailable');
  }
});
test('wrong accounts, duplicate heroes and duplicate source slots fail closed',()=>{
  for(const alter of [(s:ReturnType<typeof fixture>)=>{s.candidate.players[0]!.accountId='9999';},
    (s:ReturnType<typeof fixture>)=>{s.candidate.players[0]!.heroId=2;},
    (s:ReturnType<typeof fixture>)=>{(s.candidate.receipt!.projection.players as {player_slot:number}[])[0]!.player_slot=1;},
    (s:ReturnType<typeof fixture>)=>{s.candidate.players.pop();}]){
    const s=fixture();alter(s);expect(verifyNativeDraft(s).status).toBe('unavailable');
  }
});
test('wrong teams or account-to-hero association cannot be accepted from selected ID alone',()=>{
  const s=fixture();s.candidate.radiantTeamId='999';expect(verifyNativeDraft(s).reasons).toContain('TEAM_SIDES_MISMATCH');
  const q=fixture();[q.capture.snapshot.players[0]!.heroId,q.capture.snapshot.players[1]!.heroId]=[2,1];rehash(q);
  expect(verifyNativeDraft(q).reasons).toContain('DRAFT_PARTICIPANTS_MISMATCH');
});
test('capture hash and clocks cannot be rewritten',()=>{
  const s=fixture();s.capture.snapshot.players[0]!.accountId='123';expect(()=>verifyNativeDraft(s)).toThrow('capture_hash_mismatch');
  rehash(s);s.inspectedAt='2025-01-01T00:00:00.000000Z';expect(verifyNativeDraft(s).reasons).toContain('CAPTURE_CLOCK_INCONSISTENT');
});
test('request IDs and bigint IDs remain strings; clients cannot inject evidence or eligibility',()=>{
  const request={requestId:'123e4567-e89b-42d3-a456-426614174000',matchId:'9007199254740995'};
  expect(DraftNativeRequestSchema.parse(request)).toEqual(request);
  for(const extra of [{matchId:9007199254740996},{matchId:'9223372036854775808'},{primaryEligible:true},{candidate:{}}])
    expect(DraftNativeRequestSchema.safeParse({...request,...extra}).success).toBe(false);
});
