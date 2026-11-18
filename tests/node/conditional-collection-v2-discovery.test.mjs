import test from 'node:test';
import assert from 'node:assert/strict';
import {replayCollectionV2Discovery} from '../../tools/research/conditional-collection-v2-discovery.mjs';
import {discoveryFixture,discoveryResponse as response,discoveryReserve,discoveryEvent,discoveryAt} from '../fixtures/conditional-collection-v2-discovery.mjs';
import {map} from '../fixtures/conditional-registered-collector.mjs';
const replay=f=>replayCollectionV2Discovery(f,async q=>f.responses.get(q.requestId));
test('empty journal suggests the first registered league and grants no collection or scoring authority',async()=>{
 const f=await discoveryFixture(),r=await replay(f);assert.equal(r.nextRequest.endpoint,'/leagues/90001/matches');assert.equal(r.maps.length,0);
 assert.equal(r.denominatorComplete,false);assert.equal(r.verifiedProMaps,null);assert.equal(r.collectionAllowed,false);assert.equal(r.activationAllowed,false);
});
test('archive replay binds BIGINT targets, preserves source references and never projects winners or performance',async()=>{
 const f=await discoveryFixture(),row=map();response(f,'/leagues/90001/matches',[{...row,radiant_win:true,duration:3000,players:[{kills:42}]}]);
 response(f,'/leagues/90002/matches',[]);response(f,'/matches/'+row.match_id,row);response(f,'/proMatches',[row]);response(f,'/proMatches?less_than_match_id='+row.match_id,[]);
 const r=await replay(f);assert.equal(r.maps.length,1);assert.equal(r.observedPossibleMaps,1);assert.equal(r.maps[0].detailCaptured,true);
 assert.equal(r.maps[0].observations.length,3);assert.equal(r.maps[0].eligibleForScoring,false);assert.equal(r.nextRequest,null);
 assert.equal(r.passes[0].status,'endpoint_end_observed');assert.equal(r.denominatorComplete,false);
 for(const key of ['radiant_win','duration','players','kills'])assert(!JSON.stringify(r).includes('"'+key+'"'));
 assert.deepEqual(await replay(f),r);
});
test('cursor gaps, unstarted pagination and details never discovered fail closed',async()=>{
 for(const endpoint of ['/proMatches?less_than_match_id=99','/matches/9007199254741201']){
  const f=await discoveryFixture();response(f,endpoint,endpoint.startsWith('/matches')?map():[]);await assert.rejects(replay(f),/cursor|undiscovered/);}
 const f=await discoveryFixture();response(f,'/proMatches',[map('100')]);response(f,'/proMatches?less_than_match_id=99',[]);
 await assert.rejects(replay(f),/cursor/);
});
test('invalid JSON, duplicate keys, duplicate map rows, UTF8 errors and unsafe IDs remain invalid with no candidates',async()=>{
 for(const body of ['{bad','[{"match_id":"1","match_id":"2"}]',[map('1'),map('1')],Buffer.from([255]),[map(9007199254740992)]]){
  const f=await discoveryFixture();response(f,'/proMatches',body);const r=await replay(f);
  assert.equal(r.requests[0].status,'invalid_response');assert.equal(r.maps.length,0);assert.equal(r.nextRequest,null);assert(r.reasons.includes('INVALID_DISCOVERY_RESPONSE'));
 }
});
test('overlapping page is invalid and does not advance cursor or erase previously discovered maps',async()=>{
 const f=await discoveryFixture();response(f,'/proMatches',[map('100')]);response(f,'/proMatches?less_than_match_id=100',[map('100'),map('90')]);
 const r=await replay(f);assert.equal(r.passes[0].cursor,'100');assert.equal(r.maps.length,1);assert.equal(r.requests[1].status,'invalid_response');
});
test('short nonempty page does not imply end; explicit new root retains an incomplete earlier pass',async()=>{
 const f=await discoveryFixture();response(f,'/proMatches',[map('100')]);response(f,'/proMatches',[map('110')]);
 const r=await replay(f);assert.equal(r.passes.length,2);assert.equal(r.passes[0].status,'superseded_incomplete');assert.equal(r.passes[1].cursor,'110');
 assert.equal(r.maps.length,2);assert.equal(r.denominatorComplete,false);assert(r.reasons.includes('GLOBAL_SCAN_INCOMPLETE'));
});
test('metadata conflicts, missing IDs and endpoint disagreements stay visible without inferring league from URL',async()=>{
 const f=await discoveryFixture();response(f,'/leagues/90001/matches',[map('100',{leagueid:null,series_id:0}),map('101',{leagueid:'7'})]);
 response(f,'/proMatches',[map('100',{radiant_team_id:'99'})]);const r=await replay(f),a=r.maps.find(m=>m.matchId==='100'),b=r.maps.find(m=>m.matchId==='101');
 assert(a.reasons.includes('METADATA_CONFLICT'));assert.equal(a.metadata.radiant_team_id,null);assert.equal(a.observations[0].row.leagueid,null);
 assert(b.reasons.includes('LEAGUE_ENDPOINT_CONFLICT'));assert(b.reasons.includes('FOREIGN_EVENT'));
 const g=await discoveryFixture();response(g,'/leagues/90001/matches',[map('5',{leagueid:null,series_id:0,start_time:null})]);
 const x=(await replay(g)).maps[0];for(const reason of ['EVENT_SCOPE_UNKNOWN','SERIES_UNKNOWN','START_UNKNOWN'])assert(x.reasons.includes(reason));
});
test('conflicts or boundary exclusions propagate to observed siblings of the same series',async()=>{
 const f=await discoveryFixture();response(f,'/leagues/90001/matches',[map('100'),map('101',{start_time:Math.floor(Date.parse('2026-12-18T00:00:00Z')/1000)})]);
 const r=await replay(f);assert(r.maps.find(m=>m.matchId==='100').reasons.includes('SERIES_MEMBER_UNRESOLVED'));assert.equal(r.maps[1].possibleTarget,false);
});
test('exposure of one map excludes all observed members of its series and never reduces the target count',async()=>{
 const f=await discoveryFixture(),p=JSON.parse(f.registration.packageText),exposed=JSON.parse(p.exposureText).mapIds[0];assert(exposed);
 response(f,'/leagues/90001/matches',[map(exposed),map('9007199254741201')]);const r=await replay(f);
 assert.equal(r.observedPossibleMaps,2);assert(r.maps.every(m=>m.reasons.includes('EXPOSED_MAP_OR_SERIES')));
});
test('300-target limit counts unique potential maps including exclusions and stops after overflow without truncation',async()=>{
 const f=await discoveryFixture();response(f,'/leagues/90001/matches',Array.from({length:301},(_,i)=>map(String(1000+i))));
 const r=await replay(f);assert.equal(r.maps.length,301);assert.equal(r.observedPossibleMaps,301);assert(r.reasons.includes('TARGET_BUDGET_EXCEEDED'));assert.equal(r.nextRequest,null);
 response(f,'/leagues/90002/matches',[]);await assert.rejects(replay(f),/target_budget/);
});
test('pending and failed attempts do not read nonexistent bodies; Retry-After remains a stop',async()=>{
 const f=await discoveryFixture(),id=discoveryReserve(f,'/proMatches');let reads=0;
 const r=await replayCollectionV2Discovery(f,async()=>{reads++;throw Error('unexpected_read');});assert.equal(reads,0);assert.equal(r.nextRequest,null);
 discoveryEvent(f,{kind:'fail',requestId:id,httpStatus:429,code:'http_error',retryAfterAt:'2026-12-04T01:00:00.000Z'},
  {kind:'failed',httpStatus:429,code:'http_error',retryAfterAt:'2026-12-04T01:00:00.000Z'});
 assert((await replay(f)).reasons.includes('RETRY_AFTER'));
});
test('bytes, receipt metadata, registration and event chain tampering are rejected',async()=>{
 const f=await discoveryFixture(),id=response(f,'/proMatches',[map()]);f.responses.get(id).bytes[0]=0;await assert.rejects(replay(f),/body_hash/);
 const g=await discoveryFixture(),gid=response(g,'/proMatches',[]);g.responses.get(gid).metadataText+=' ';await assert.rejects(replay(g),/receipt_hash/);
 const h=await discoveryFixture();h.registration.packageText+=' ';await assert.rejects(replay(h),/registration_hash/);
 const k=await discoveryFixture();response(k,'/proMatches',[]);k.events[0].event_text+=' ';await assert.rejects(replay(k),/hash/);
});
test('wrong detail identity is invalid, no detail is silently counted as captured',async()=>{
 const f=await discoveryFixture();response(f,'/proMatches',[map('100')]);response(f,'/matches/100',map('101'));
 const r=await replay(f);assert.equal(r.requests[1].status,'invalid_response');assert.equal(r.maps[0].detailCaptured,false);assert.equal(r.maps.length,1);
});
test('window boundaries are strict and an empty scan never proves complete event inventory',async()=>{
 const f=await discoveryFixture();response(f,'/leagues/90001/matches',[map('100',{start_time:Math.floor(Date.parse('2026-11-20T00:00:00Z')/1000)}),
  map('101',{start_time:Math.floor(Date.parse('2026-12-18T00:00:00Z')/1000)})]);response(f,'/proMatches',[]);
 const r=await replay(f);assert.equal(r.maps[0].possibleTarget,true);assert.equal(r.maps[1].possibleTarget,false);assert.equal(r.denominatorComplete,false);
 assert(r.reasons.includes('DENOMINATOR_REQUIRES_REVIEWED_EVENT_REGISTER'));assert.equal(r.snapshotAt,discoveryAt);
});
test('300 targets exactly are retained and duplicate observations never increase the count',async()=>{
 const f=await discoveryFixture(),rows=Array.from({length:300},(_,i)=>map(String(2000+i)));
 response(f,'/leagues/90001/matches',rows);response(f,'/leagues/90001/matches',rows);
 const r=await replay(f);assert.equal(r.observedPossibleMaps,300);assert.equal(r.observationCount,600);assert(!r.reasons.includes('TARGET_BUDGET_EXCEEDED'));
});
test('an observed empty end may be revisited explicitly and newly appearing maps do not disappear from inventory',async()=>{
 const f=await discoveryFixture();response(f,'/proMatches',[]);response(f,'/proMatches',[map('120')]);
 response(f,'/proMatches?less_than_match_id=120',[]);const r=await replay(f);
 assert.equal(r.passes.length,2);assert(r.passes.every(p=>p.status==='endpoint_end_observed'));assert.equal(r.maps[0].matchId,'120');
});
test('bounded projection rejects over 100000 metadata observations instead of silently truncating the denominator',async()=>{
 const f=await discoveryFixture(),rows=Array.from({length:20000},(_,i)=>map(String(100000+i),{leagueid:'7',series_id:null}));
 for(let i=0;i<6;i++)response(f,'/proMatches',rows);
 await assert.rejects(replay(f),/discovery_observation_limit/);
});
