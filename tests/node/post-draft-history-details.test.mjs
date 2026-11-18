import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {projectDetail,assessDetail,collectDetails,detailBudget,validateDetailPlan} from '../../tools/research/post-draft-history-details.mjs';
import {OpenDotaError,OpenDotaClient} from '../../packages/ingestion/dist/index.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
const id='9007199254740993',cutoffAt='2026-09-05T00:00:00.000Z';
// Synthetic test data, never passed to the production collection command.
const map=()=>({match_id:id,start_time:1788000000,duration:2000,radiant_win:true,leagueid:'1',lobby_type:1,
 radiant_team_id:'9007199254740995',dire_team_id:'9007199254740997',series_id:'12',patch:null,
 players:Array.from({length:10},(_,i)=>({account_id:String(10001+i),hero_id:i+1,player_slot:i<5?i:i+123}))});
const identities=()=>map().players.map((p,i)=>({playerId:String(i+1),provider:'opendota',externalAccountId:p.account_id,status:'verified',eventAt:null,
 knownAt:null,fetchedAt:'2026-11-13T00:00:00.000Z',evidenceRef:'synthetic-test-proof',source:'synthetic-test',observationId:'proof:'+i}));
function observation(data){const rawBody=JSON.stringify(data);return {data,rawBody,source:{provider:'opendota',adapterVersion:'opendota-provider-v2',endpoint:`/matches/${id}`,
 fetchedAt:'2026-11-13T00:00:00.000Z',knownAt:null,payloadSha256:sha(rawBody),attempts:1}};}
const candidate=()=>({matchId:id,observations:[{queryIndex:0,row:{account_id:'10001',match_id:id,player_slot:0,leagueid:'1',start_time:1788000000,duration:2000,radiant_win:true,tier:'professional'}}]});
const check=(m=map(),c=candidate(),queries=[{cutoffAt}],ids=identities(),leagues=[{leagueid:'1',tier:'professional'}])=>assessDetail(projectDetail(observation(m),id),c,queries,leagues,ids);

test('projection strips profiles/chat, distinguishes original hash and preserves exact bigint IDs and clocks',()=>{
 const m=map();m.chat=[{text:'private'}];m.players[0].personaname='private';
 const o=observation(m),p=projectDetail(o,id),r=assessDetail(p,candidate(),[{cutoffAt}],[{leagueid:'1',tier:'professional'}],identities());
 assert(!JSON.stringify(p).includes('private'));assert.notEqual(p.projectionSha256,p.source.payloadSha256);
 assert.equal(p.source.payloadSha256,sha(o.rawBody));assert.equal(p.originalResponseBytesRetained,false);
 assert.equal(r.sourceConsistent,true);assert.deepEqual(r.coverageReasons,[]);assert.equal(r.sourceTeamIds.radiant,'9007199254740995');
 assert.equal(r.canonicalPatchId,null);assert.equal(r.sourceClock.knownAt,null);assert.equal(r.trainingEligible,false);
});

test('synthetic markers cannot disappear through projection; original hash/ID/knownAt must bind',()=>{
 for(const fields of [{synthetic:true},{synthetic:false},{_fixture:'x'}])assert.throws(()=>projectDetail(observation({...map(),...fields}),id));
 for(const mutate of [o=>o.rawBody='{}',o=>o.source.knownAt=cutoffAt,o=>o.source.endpoint='/matches/1']){
  const o=observation(map());mutate(o);assert.throws(()=>projectDetail(o,id));
 }
 assert.throws(()=>projectDetail(observation({...map(),match_id:'1'}),id));
 const p=projectDetail(observation(map()),id);p.projection.players[0].hero_id=111;
 assert.throws(()=>assessDetail(p,candidate(),[{cutoffAt}],[],[]),/projection_binding/);
});

test('each discovery cutoff requires strictly earlier completed outcome, including equality boundary',()=>{
 const c=candidate();c.observations.push({...c.observations[0],queryIndex:1});
 const boundary=new Date((1788000000+2000)*1000).toISOString();
 assert(check(map(),c,[{cutoffAt},{cutoffAt:boundary}]).sourceReasons.includes('STRICT_COMPLETION_REQUIRED'));
 assert.equal(check(map(),c,[{cutoffAt},{cutoffAt:new Date(Date.parse(boundary)+1000).toISOString()}]).sourceConsistent,true);
});

test('outcome, time, league and discovered slot conflicts remain visible',()=>{
 for(const fields of [{radiant_win:false},{start_time:1788000001},{duration:2001},{leagueid:'2'}])assert(check({...map(),...fields}).sourceReasons.includes('DISCOVERY_DETAIL_CONFLICT'));
 const m=map();m.players[0].player_slot=1;assert(check(m).sourceReasons.includes('PLAYER_PARTICIPATION_REQUIRED'));
 assert(check(map(),candidate(),[{cutoffAt}],identities(),[]).sourceReasons.includes('PRO_LEAGUE_REQUIRED'));
 assert(check({...map(),lobby_type:7}).sourceReasons.includes('TOURNAMENT_LOBBY_REQUIRED'));
});

test('missing side is not guessed, partial/duplicate players or heroes stay ineligible',()=>{
 const m=map();delete m.dire_team_id;const r=check(m);assert.equal(r.sourceTeamIds.dire,null);assert(r.coverageReasons.includes('TEAM_SIDES_UNKNOWN'));
 for(const edit of [m=>m.players.pop(),m=>m.players[9].hero_id=1,m=>m.players[9].account_id='10001',m=>m.players[9].player_slot=0]){
  const m=map();edit(m);assert(check(m).coverageReasons.length>0);
 }
 assert(check({...map(),radiant_team:{team_id:'99'}}).coverageReasons.includes('TEAM_REFERENCE_CONFLICT'));
 const malformed=check({...map(),players:'invalid'});assert.equal(malformed.sourceConsistent,false);assert(malformed.sourceReasons.includes('SOURCE_SCHEMA_INVALID'));
});

test('current verified identity is separate from as-of proof; conflicts and cross-account links cannot be merged',()=>{
 assert(check(map(),candidate(),[{cutoffAt}],[]).coverageReasons.includes('CANONICAL_IDENTITY_UNKNOWN'));
 const ids=identities();ids.push({...ids[0],playerId:'99',observationId:'conflict'});
 assert(check(map(),candidate(),[{cutoffAt}],ids).coverageReasons.includes('CANONICAL_IDENTITY_CONFLICT'));
 const linked=identities();linked.push({...linked[0],externalAccountId:'20000',observationId:'other-account'});
 assert(check(map(),candidate(),[{cutoffAt}],linked).coverageReasons.includes('CANONICAL_IDENTITY_CROSS_ACCOUNT_UNSUPPORTED'));
 assert.equal(check().identityBasis,'current_verified_same_numeric_account_from_frozen_capture');
});

test('partial collection preserves first receipt, sanitizes error, and makes no later calls',async()=>{
 const saved=[],calls=[];const rows=await collectDetails(['1','2','3'],async id=>{calls.push(id);if(id==='2')throw Error('secret');return {id};},r=>saved.push(r));
 assert.deepEqual(calls,['1','2']);assert.deepEqual(rows.map(r=>r.status),['observed','unavailable','not_attempted']);
 assert.deepEqual(rows,saved);assert(!JSON.stringify(rows).includes('secret'));
});

test('global and per-map attempt guards run before shared quota and preserve Retry-After',async()=>{
 let permits=0,observed;const shared={beforeRequest:async()=>{permits++;},observe:async(...a)=>{observed=a;}};
 const state={attempts:99,mapAttempts:1},b=detailBudget(shared,state);await b.beforeRequest();assert.equal(permits,1);
 state.attempts=100;await assert.rejects(b.beforeRequest());state.attempts=1;state.mapAttempts=2;await assert.rejects(b.beforeRequest());assert.equal(permits,1);
 await b.observe(429,60000);assert.deepEqual(observed,[429,60000]);
 const rows=await collectDetails(['1','2'],async()=>{throw new OpenDotaError('source_rate_limited',null,429,60000);},()=>{});
 assert.equal(rows[0].retryAfterMs,60000);assert.equal(rows[1].status,'not_attempted');
});

test('existing HTTP client retries count against the same total and per-map counter',async()=>{
 const state={attempts:0,mapAttempts:0};let permits=0;
 const shared={beforeRequest:async()=>{permits++;},observe:async()=>{}};
 const client=new OpenDotaClient({maxRequests:100,attempts:2,requestsPerMinute:45,maxWaitMs:5000},{budget:detailBudget(shared,state),
  fetch:async()=>{state.attempts++;state.mapAttempts++;return state.attempts===1?new Response('{}',{status:503}):new Response(JSON.stringify(map()),{status:200});}});
 const o=await client.getMatchSource(id);assert.equal(o.data.match_id,id);assert.equal(state.attempts,2);assert.equal(permits,2);
});

test('registered 95-map proposal rejects broadened budget or reordered/duplicate IDs',()=>{
 const p=JSON.parse(readFileSync(new URL('../../docs/evidence/s3-04-history-details-proposal.json',import.meta.url),'utf8'));
 const d={maps:[...p.mapIds.map((matchId,i)=>({matchId,knownInFrozenCapture:false,observations:[{row:{start_time:i}}]})),...p.localReview.map(r=>({...r,knownInFrozenCapture:true}))]};
 assert.equal(validateDetailPlan(p,d),p);
 for(const edit of [p=>p.mapIds.reverse(),p=>p.mapIds[0]=p.mapIds[1],p=>p.budget.maxDetailHttpAttemptsIncludingRetries=101,p=>p.budget.profileRequests=1,p=>p.localReview=[]]){
  const q=structuredClone(p);edit(q);assert.throws(()=>validateDetailPlan(q,d));
 }
});
