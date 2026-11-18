import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {auditLocalReadiness} from '../../tools/research/post-draft-local-readiness.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fixture=()=>{
 const accounts=Array.from({length:10},(_,i)=>String(100+i));
 const p={match_id:'9007199254740993',start_time:1788000000,leagueid:'9',series_id:'8',series_type:1,radiant_team_id:'11',dire_team_id:'12'};
 const details={rows:[{matchId:p.match_id,status:'observed',receipt:{basis:'validated_http_projected',projection:p,projectionSha256:sha(JSON.stringify(p))},
  assessment:{members:accounts.map(accountId=>({accountId})),sourceReasons:[],coverageReasons:[]}}]};
 const capture={mapIds:[p.match_id],accounts,identities:accounts.map((a,i)=>({observationId:'proof:'+i,playerId:String(i+1),externalAccountId:a,provider:'opendota',status:'verified',
  eventAt:null,knownAt:null,fetchedAt:'2026-11-13T00:00:00.000Z',evidenceRef:'synthetic-test',source:'synthetic-test'})),
  players:accounts.map((a,i)=>({id:String(i+1),opendota_account_id:a})),legacy:[],profiles:[],
  teams:[{id:'1',opendota_team_id:'11'},{id:'2',opendota_team_id:'12'}],leagues:[{id:'1',opendota_league_id:'9',tier:'professional'}],
  series:[{id:'uuid',provider:'opendota',provider_series_id:'8',radiant:'11',dire:'12',league:'9',best_of:3}],seriesReceipts:[],maps:[]};
 return {details,capture,cache:{entries:[]}};
};
const run=f=>auditLocalReadiness(f.details,f.capture,f.cache);
test('verified numeric identities and existing references are local prerequisites, never training permission',()=>{
 const r=run(fixture());assert.equal(r.counts.localPrerequisitesReady,1);assert.equal(r.maps[0].trainingEligible,false);
 assert.equal(r.maps[0].remoteMembershipCompleteness,'unknown');assert.equal(r.maps[0].mapNumber,null);
 assert.equal(r.accounts[0].knownBeforeHistoricalMap,'not_asserted');assert.equal(r.maps[0].matchId,'9007199254740993');
});
test('empty local evidence stays unknown even with a numeric profile; no alias or automatic provisioning',()=>{
 const f=fixture();f.capture.identities=[];f.cache.entries=[{status:'observed',source:{fetchedAt:'2026-11-13T00:00:00.000Z'},matches:[{accountId:'100',steam64:'76561197960265828',name:'same nickname'}]}];
 const r=run(f);assert.equal(r.counts.blockedAccounts,10);assert.equal(r.accounts[0].numericProofCandidates.length,1);assert.equal(r.accounts[0].playerId,null);assert.equal(r.counts.localPrerequisitesReady,0);
});
test('conflicting identities, cross-account histories and numeric canonical mismatches fail closed',()=>{
 for(const edit of [f=>f.capture.identities.push({...f.capture.identities[0],playerId:'99',observationId:'conflict'}),
  f=>f.capture.identities.push({...f.capture.identities[0],externalAccountId:'999',observationId:'other-account'}),
  f=>f.capture.players[0].opendota_account_id='999']){
  const f=fixture();edit(f);assert.equal(run(f).accounts[0].status,'blocked');assert.equal(run(f).counts.localPrerequisitesReady,0);
 }
});
test('one series may have swapped native sides; wrong provider or league never matches by numeric ID alone',()=>{
 const f=fixture();[f.capture.series[0].radiant,f.capture.series[0].dire]=['12','11'];assert.equal(run(f).counts.localPrerequisitesReady,1);
 f.capture.series[0].provider='pandascore';assert(run(f).maps[0].reasons.includes('CANONICAL_SERIES_UNRESOLVED'));
 f.capture.series[0].provider='opendota';f.capture.series[0].league='99';assert(run(f).maps[0].reasons.includes('CANONICAL_SERIES_CONFLICT'));
});
test('same opponents/day with different source series is review-only, never auto-merge or map-number inference',()=>{
 const f=fixture(),r=structuredClone(f.details.rows[0]);r.matchId='9007199254740994';r.receipt.projection.match_id=r.matchId;r.receipt.projection.series_id='9';
 r.receipt.projectionSha256=sha(JSON.stringify(r.receipt.projection));f.details.rows.push(r);f.capture.mapIds.push(r.matchId);
 const report=run(f);assert.equal(report.groupingReviews.length,1);assert.equal(report.groupingReviews[0].automaticMergeAllowed,false);
 assert(report.maps.every(m=>m.reasons.includes('SERIES_GROUP_REVIEW_REQUIRED')&&m.mapNumber===null));
});
test('missing references, quarantined receipts and linked-elsewhere maps retain distinct blockers',()=>{
 const f=fixture();f.capture.teams=[];f.capture.leagues=[];f.capture.seriesReceipts=[{series_id:'8',map_id:'55',status:'quarantined'}];
 f.capture.maps=[{id:f.capture.mapIds[0],provider:'opendota',provider_series_id:'other'}];
 const r=run(f);assert.deepEqual(r.counts.missingTeamIds,['11','12']);assert.deepEqual(r.counts.missingLeagueIds,['9']);
 for(const reason of ['LOCAL_SERIES_RECEIPT_CONFLICT','MAP_LINKED_ELSEWHERE'])assert(r.maps[0].reasons.includes(reason));
 assert.deepEqual(r.maps[0].observedMapIdsForSourceSeries,['55','9007199254740993']);
});
test('scope, original projection hash and previous source/hero quality cannot silently change',()=>{
 const f=fixture();f.capture.mapIds=['1'];assert.throws(()=>run(f),/capture_scope/);
 const g=fixture();g.details.rows[0].receipt.projection.series_id='2';assert.throws(()=>run(g),/detail_binding/);
 const h=fixture();h.details.rows[0].assessment.coverageReasons=['TEN_DISTINCT_FINAL_HEROES_REQUIRED'];assert.equal(run(h).counts.localPrerequisitesReady,0);
});
test('old numeric-proof failure remains visible without new lookup or fabricated steam proof',()=>{
 const f=fixture();f.capture.identities=[];f.cache.entries=[{status:'observed',source:{},matches:[{accountId:'100',steam64:'76561197960265829'}]}];
 const old={accountId:'100',status:'blocked',reasons:['NUMERIC_PROOF_MISSING']};
 const r=auditLocalReadiness(f.details,f.capture,f.cache,old);assert.equal(r.accounts[0].numericProofCandidates.length,0);
 assert.deepEqual(r.accounts[0].previousCheck,old);assert.equal(r.providerHttp,0);assert.equal(r.businessWrites,0);
});
