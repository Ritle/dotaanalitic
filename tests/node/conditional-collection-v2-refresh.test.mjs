import test from 'node:test';
import assert from 'node:assert/strict';
import {CollectionV2RefreshRequest,projectCollectionV2Refresh,collectionV2RefreshManifestPaths} from '../../tools/research/conditional-collection-v2-refresh.mjs';
const marker={sweep_id:'11111111-1111-4111-8111-111111111111',base_request_count:2,marker_sha256:'a'.repeat(64)};
function report(){return {journalHeadSha256:'b'.repeat(64),scope:[{leagueId:'1'},{leagueId:'2'}],
 requests:[{requestId:'old1',kind:'league',endpoint:'/leagues/1/matches',status:'projected'},
 {requestId:'old2',kind:'global',endpoint:'/proMatches',status:'projected'}],passes:[{rootRequestId:'old2',status:'endpoint_end_observed',cursor:null}],
 maps:[{matchId:'100',possibleTarget:true,detailCaptured:true,reasons:[]}],reasons:[],nextRequest:null,denominatorComplete:false};}
test('new sweep ignores old list freshness, preserves captured details and requires its own global end',()=>{
 const r=report();assert.equal(projectCollectionV2Refresh(r,marker).nextRequest.endpoint,'/leagues/1/matches');
 r.requests.push({requestId:'new1',kind:'league',endpoint:'/leagues/1/matches',status:'projected'},
 {requestId:'new2',kind:'league',endpoint:'/leagues/2/matches',status:'projected'});
 assert.equal(projectCollectionV2Refresh(r,marker).nextRequest.endpoint,'/proMatches');
 r.maps.push({matchId:'101',possibleTarget:true,detailCaptured:false,reasons:['DETAIL_NOT_CAPTURED']});
 assert.equal(projectCollectionV2Refresh(r,marker).nextRequest.endpoint,'/matches/101');
 r.maps[1].detailCaptured=true;r.requests.push({requestId:'new3',kind:'global',endpoint:'/proMatches',status:'projected'});
 r.passes.push({rootRequestId:'new3',status:'bounded',cursor:'101'});
 assert.equal(projectCollectionV2Refresh(r,marker).nextRequest.endpoint,'/proMatches?less_than_match_id=101');
 r.passes[1].status='endpoint_end_observed';assert.equal(projectCollectionV2Refresh(r,marker).sweepComplete,true);
 assert.equal(projectCollectionV2Refresh(r,marker).denominatorComplete,false);
});
test('bad, unknown, pending, budget and window states cannot look complete or grant requests',()=>{
 for(const code of ['INVALID_DISCOVERY_RESPONSE','UNKNOWN_REQUEST_OUTCOME_REQUIRES_REVIEW','REQUEST_IN_FLIGHT','TOTAL_BUDGET_EXHAUSTED',
 'DAILY_BUDGET_EXHAUSTED','TARGET_BUDGET_EXCEEDED','RETRY_AFTER','PROVIDER_AUTH_FAILED','COLLECTION_NOT_STARTED','COLLECTION_WINDOW_CLOSED']){
 const r=projectCollectionV2Refresh({...report(),reasons:[code]},marker);assert.equal(r.nextRequest,null);assert.equal(r.sweepComplete,false);}
 assert.throws(()=>projectCollectionV2Refresh(report(),{...marker,base_request_count:3}));
});
test('strict begin and resume contracts require explicit identity and reject authority or remote options',()=>{
 const base={mode:'local-synthetic',ownerId:marker.sweep_id,registrationId:marker.sweep_id,registrationSha256:'c'.repeat(64),localOrigin:'http://127.0.0.1:4567',
 sweep:{action:'begin',sweepId:marker.sweep_id,expectedHeadSha256:'b'.repeat(64)}};
 assert.equal(CollectionV2RefreshRequest.parse(base).maxRequests,5);
 assert(CollectionV2RefreshRequest.safeParse({...base,sweep:{action:'resume',sweepId:marker.sweep_id}}).success);
 for(const extra of [{sweep:{action:'begin',sweepId:marker.sweep_id}},{sweep:{action:'resume',sweepId:marker.sweep_id,reset:true}},
 {localOrigin:'https://api.opendota.com'},{collectionAllowed:true},{maxRequests:21}])assert.equal(CollectionV2RefreshRequest.safeParse({...base,...extra}).success,false);
});
test('refresh manifest adds its source, CLI and forward migration without replacing frozen runtime',async()=>{
 const paths=await collectionV2RefreshManifestPaths();assert.equal(paths.length,new Set(paths).size);
 for(const p of ['tools/research/conditional-collection-v2-refresh.mjs','tools/research/run-conditional-collection-v2-refresh.mjs',
 'packages/db/migrations/070_conditional_collection_v2_sweeps.sql','tools/research/conditional-collection-v2-runtime.mjs'])assert(paths.includes(p));
});
