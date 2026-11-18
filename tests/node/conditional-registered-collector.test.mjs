import test from 'node:test';
import assert from 'node:assert/strict';
import {replayRegisteredCollection,appendRegisteredCollection} from '../../tools/research/conditional-registered-collector.mjs';
import {realSha} from '../../tools/research/conditional-real-registration.mjs';
import {collectorFixture,scan,begin,finish,response,map,collectionAt} from '../fixtures/conditional-registered-collector.mjs';
const run=f=>replayRegisteredCollection(f.registration,f.log,realSha(JSON.stringify(f.log)));
test('binds the committed package and fixed scope; no collection or scoring authority',async()=>{
 const f=await collectorFixture(),r=run(f);assert.equal(r.registrationSha256,f.registration.packageSha256);
 assert.equal(r.nextRequest.endpoint,'/leagues/90001/matches');assert.equal(r.denominatorComplete,false);assert.equal(r.collectionAllowed,false);assert.equal(r.deployable,false);
 assert.equal(r.verifiedProMaps,null);assert.equal(r.observedPossibleMaps,0);
});
test('missing receipt, changed package, registration ID and externally pinned log SHA fail closed',async()=>{
 for(const mutate of [f=>f.registration.registeredAt=null,f=>f.registration.status='commit_unconfirmed',f=>f.registration.packageText+=' ',
  f=>f.log.registrationId='99999999-9999-4999-8999-999999999999',f=>f.log.registrationSha256='a'.repeat(64)]){
  const f=await collectorFixture();mutate(f);assert.throws(()=>run(f));
 }
 const f=await collectorFixture();assert.throws(()=>replayRegisteredCollection(f.registration,f.log,'f'.repeat(64)),/log_hash/);
 delete f.p.executable.code['tools/research/conditional-registered-collector.mjs'];f.registration.packageText=JSON.stringify(f.p);
 f.registration.packageSha256=realSha(f.registration.packageText);f.log.registrationSha256=f.registration.packageSha256;
 assert.throws(()=>run(f),/collector_not_in_registered_manifest/);
});
test('keeps BIGINT map IDs, repeated observations and metadata conflicts without counting maps twice',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',[map()]);response(f,'/leagues/90001/matches',[map(undefined,{series_id:'999999998'})]);
 const r=run(f);assert.equal(r.maps.length,1);assert.equal(r.maps[0].matchId,'9007199254741201');
 assert.equal(r.maps[0].observations.length,2);assert(r.maps[0].reasons.includes('METADATA_CONFLICT'));assert.equal(r.attempts.total,2);
});
test('unknown metadata stays unresolved; outside-window and foreign rows remain visible',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',[
  map('9007199254741201',{leagueid:null,start_time:null}),map('9007199254741202',{start_time:1}),map('9007199254741203',{leagueid:'20359'})]);
 const r=run(f);assert.equal(r.maps.length,3);assert(r.maps[0].reasons.includes('START_UNKNOWN'));
 assert(r.maps[1].reasons.includes('OUTSIDE_WINDOW'));assert(r.maps[2].reasons.includes('LEAGUE_ENDPOINT_CONFLICT'));assert.equal(r.denominatorComplete,false);
});
test('partial and short responses never establish a complete denominator; global cursor is verified',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',[map()]);response(f,'/leagues/90002/matches',[]);
 response(f,'/proMatches',[map()]);let r=run(f);assert.equal(r.scans[0].globalStatus,'bounded');assert.equal(r.denominatorComplete,false);
 response(f,'/proMatches?less_than_match_id=9007199254741201',[]);r=run(f);assert.equal(r.scans[0].globalStatus,'exhausted');assert.equal(r.denominatorComplete,false);
 const bad=structuredClone(f);bad.log.events.at(-2).endpoint='/proMatches?less_than_match_id=1';assert.throws(()=>run(bad),/cursor/);
});
test('new scans preserve cumulative inventory and budget while resetting only cursor coverage',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',[map()]);scan(f);response(f,'/leagues/90001/matches',[]);
 const r=run(f);assert.equal(r.maps.length,1);assert.equal(r.attempts.total,2);assert.equal(r.scans.length,2);
 assert(r.reasons.includes('LATEST_LEAGUE_RESPONSE_MISSING'));assert.equal(r.scans[1].globalStatus,'not_requested');
});
test('an interrupted request consumes budget and prevents concurrent or silently abandoned work',async()=>{
 const f=await collectorFixture();scan(f);begin(f,'/leagues/90001/matches');const r=run(f);
 assert.equal(r.attempts.total,1);assert.equal(r.nextRequest,null);assert(r.reasons.includes('REQUEST_IN_FLIGHT'));
 begin(f,'/leagues/90002/matches');assert.throws(()=>run(f),/concurrent_request/);
});
test('Retry-After survives a new scan; failures and every retry count',async()=>{
 const f=await collectorFixture();scan(f);const id=begin(f,'/leagues/90001/matches');
 f.log.events.push({kind:'request_finished',sequence:f.log.events.length,requestId:id,at:collectionAt,
  result:{status:'failed',httpStatus:429,code:'rate_limited',retryAfterAt:'2026-12-19T01:00:00.000Z'}});
 scan(f);let r=run(f);assert(r.reasons.includes('RETRY_AFTER'));assert.equal(r.attempts.total,1);assert.equal(r.nextRequest,null);
 const bad=structuredClone(f);begin(bad,'/leagues/90001/matches');assert.throws(()=>run(bad),/retry_after/);
 f.log.snapshotAt='2026-12-19T01:00:00.000Z';response(f,'/leagues/90001/matches',[],f.log.snapshotAt);r=run(f);assert.equal(r.attempts.total,2);
});
test('daily cap cannot be reset by starting another scan',async()=>{
 const f=await collectorFixture();scan(f);for(let i=0;i<100;i++)response(f,'/leagues/90001/matches',[]);
 scan(f);assert(run(f).reasons.includes('DAILY_BUDGET_EXHAUSTED'));begin(f,'/leagues/90002/matches');assert.throws(()=>run(f),/daily_budget/);
});
test('wrong or duplicate map details and malformed JSON are retained as invalid attempts',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',[map()]);response(f,'/matches/9007199254741201',map('9007199254741202'));
 response(f,'/leagues/90002/matches','not json');response(f,'/leagues/90002/matches',[map(),map()]);
 const r=run(f);assert.equal(r.attempts.invalidResponses,3);assert.equal(r.attempts.total,4);assert.equal(r.maps.length,1);assert.equal(r.maps[0].detailCaptured,false);
});
test('unscoped endpoints, unknown detail IDs, future clocks and requests outside fixed collection window reject',async()=>{
 for(const endpoint of ['/leagues/20359/matches','/matches/123','https://api.opendota.com/proMatches','/proMatches?api_key=secret']){
  const f=await collectorFixture();scan(f);begin(f,endpoint);assert.throws(()=>run(f));
 }
 for(const at of ['2026-11-19T00:00:00.000Z','2026-12-25T00:00:00.000Z']){
  const f=await collectorFixture();f.log.snapshotAt=at;scan(f,at);begin(f,'/leagues/90001/matches',at);assert.throws(()=>run(f),/collection_window/);
 }
 const f=await collectorFixture();scan(f,'2026-12-20T00:00:00.000Z');assert.throws(()=>run(f),/event_clock/);
});
test('target overflow retains every ID and stops further requests rather than choosing the first 300',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',Array.from({length:301},(_,i)=>map(String(9007199254741201n+BigInt(i)))));
 const r=run(f);assert.equal(r.maps.length,301);assert(r.reasons.includes('TARGET_BUDGET_EXCEEDED'));assert.equal(r.nextRequest,null);
 begin(f,'/leagues/90002/matches');assert.throws(()=>run(f),/target_budget/);
});
test('exposure of one observed series member excludes its siblings, including outside-window maps',async()=>{
 const f=await collectorFixture(),old=JSON.parse(f.p.exposureText).mapIds[0];scan(f);
 response(f,'/leagues/90001/matches',[map(old,{start_time:1}),map()]);const r=run(f);
 assert(r.maps.find(m=>m.matchId==='9007199254741201').reasons.includes('EXPOSED_MAP_OR_SERIES'));
});
test('append verifies external prior hash and preserves the exact earlier events',async()=>{
 const f=await collectorFixture(),old=structuredClone(f.log);scan(f);const sha=realSha(JSON.stringify(old));
 const r=appendRegisteredCollection(f.registration,old,sha,f.log.events,collectionAt);
 assert.deepEqual(r.log.events,f.log.events);assert.deepEqual(old.events,[]);assert.equal(r.parentSha256,sha);
 assert.throws(()=>appendRegisteredCollection(f.registration,old,'0'.repeat(64),[],collectionAt),/log_hash/);
});
test('known outside-window maps do not exhaust the target budget and window end is exclusive',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',Array.from({length:301},(_,i)=>map(String(9007199254741201n+BigInt(i)),{start_time:1})));
 response(f,'/leagues/90001/matches',[map('9007199254741999',{start_time:Date.parse('2026-12-18T00:00:00.000Z')/1000})]);
 const r=run(f);assert.equal(r.maps.length,302);assert.equal(r.observedPossibleMaps,0);assert(!r.reasons.includes('TARGET_BUDGET_EXCEEDED'));
});
test('append cannot backdate new observations before the previous snapshot',async()=>{
 const f=await collectorFixture(),old=structuredClone(f.log);scan(f,'2026-12-18T00:00:00.000Z');
 assert.throws(()=>appendRegisteredCollection(f.registration,old,realSha(JSON.stringify(old)),f.log.events,collectionAt),/append_clock/);
});
test('daily allowance resumes on the next UTC day but total attempts are never reset',async()=>{
 const f=await collectorFixture();f.log.snapshotAt='2026-11-30T00:00:00.000Z';
 for(let day=20;day<30;day++){const at=`2026-11-${day}T00:00:00.000Z`;scan(f,at);for(let i=0;i<100;i++)response(f,'/leagues/90001/matches',[],at);}
 const r=run(f);assert.equal(r.attempts.total,1000);assert(r.reasons.includes('TOTAL_BUDGET_EXHAUSTED'));assert(!r.reasons.includes('DAILY_BUDGET_EXHAUSTED'));
 begin(f,'/leagues/90002/matches',f.log.snapshotAt);assert.throws(()=>run(f),/total_budget/);
});
test('lost response bytes and non-advancing global pages cannot certify cursor progress',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/proMatches',[map()]);response(f,'/proMatches?less_than_match_id=9007199254741201',[map()]);
 const r=run(f);assert.equal(r.attempts.invalidResponses,1);assert.equal(r.scans[0].cursor,'9007199254741201');assert.equal(r.scans[0].globalStatus,'bounded');
 f.log.events[2].result.rawBody+=' ';assert.throws(()=>run(f),/response_bytes_changed/);
});
test('authentication failure stops further requests even across scan restarts',async()=>{
 const f=await collectorFixture();scan(f);const id=begin(f,'/leagues/90001/matches');
 f.log.events.push({kind:'request_finished',sequence:f.log.events.length,requestId:id,at:collectionAt,result:{status:'failed',httpStatus:401,code:'unauthorized',retryAfterAt:null}});
 f.log.snapshotAt='2026-12-20T00:00:00.000Z';scan(f,f.log.snapshotAt);assert(run(f).reasons.includes('PROVIDER_AUTH_FAILED'));
 begin(f,'/leagues/90001/matches',f.log.snapshotAt);assert.throws(()=>run(f),/provider_auth_failed/);
});
test('detail suggestions follow retained numeric identities and do not expose outcomes as features',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches',[map()]);response(f,'/leagues/90002/matches',[]);
 assert.equal(run(f).nextRequest.endpoint,'/matches/9007199254741201');response(f,'/matches/9007199254741201',{...map(),radiant_win:true,kills:999});
 const r=run(f);assert.equal(r.maps[0].detailCaptured,true);assert.equal(r.verifiedProMaps,null);assert.equal(r.nextRequest.endpoint,'/proMatches');
 assert(!JSON.stringify(r).includes('radiant_win'));assert(!JSON.stringify(r).includes('"kills"'));
});
test('response size is limited in UTF-8 bytes, including multibyte characters',async()=>{
 const f=await collectorFixture();scan(f);response(f,'/leagues/90001/matches','é'.repeat(4194305));
 assert.throws(()=>run(f),/response_byte_limit/);
});
