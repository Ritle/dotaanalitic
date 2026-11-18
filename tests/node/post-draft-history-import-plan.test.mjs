import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildImportPlan} from '../../tools/research/post-draft-history-import-plan.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fixture=()=>{
 const accounts=Array.from({length:10},(_,i)=>String(100+i)),members=accounts.map((accountId,i)=>({accountId,canonicalPlayerId:String(i+1),heroId:i+1,slot:i<5?i:i+123}));
 const p={match_id:'9007199254740993',start_time:1788000000,duration:2000,radiant_win:true,leagueid:'9',series_id:'8',series_type:1,radiant_team_id:'11',dire_team_id:'12',radiant_team:{team_id:'11',name:'A'},dire_team:{team_id:'12',name:'B'}};
 const report={rows:[{matchId:p.match_id,status:'observed',assessment:{sourceConsistent:true,coverageReasons:[],members},receipt:{projection:p,projectionSha256:sha(JSON.stringify(p)),source:{payloadSha256:'a'.repeat(64),knownAt:null,fetchedAt:'2026-11-13T00:00:00.000Z'}}}]};
 const proposal={priorityMapIds:[p.match_id]},capture={capturedAt:'2026-11-13T00:00:00.000Z',selectedMapIds:[p.match_id],accounts,
  identities:accounts.map((a,i)=>({observationId:'proof:'+i,playerId:String(i+1),externalAccountId:a,provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:'2026-11-13T00:00:00.000Z',evidenceRef:'synthetic-test',source:'synthetic-test'})),
  players:accounts.map((a,i)=>({id:String(i+1),opendota_account_id:a,steam64_id:(76561197960265728n+BigInt(a)).toString()})),teams:[],leagues:[{id:'1',opendota_league_id:'9',tier:'professional'}],maps:[],series:[],receipts:[],
  references:[{endpoint:'/heroes',source_payload:members.map(m=>({id:m.heroId}))},{endpoint:'/leagues',source_payload:[{leagueid:'9',name:'Pro league',tier:'professional'}]}]};
 return {report,proposal,capture};
};
const run=f=>buildImportPlan(f.report,f.proposal,f.capture);
const receipt=(f,extra={})=>({id:'1',map_id:f.proposal.priorityMapIds[0],payload_map_id:f.proposal.priorityMapIds[0],canonical_match_id:null,status:'received',
 series_id:'8',series_type:'1',radiant:'11',dire:'12',league:'9',start_time:'1788000000',duration:'2000',radiant_win:'true',...extra});
test('new teams and series are explicit planned actions, distinct source/projection SHA, never working import',()=>{
 const p=run(fixture());assert.equal(p.counts.plannedMaps,1);assert.equal(p.counts.newTeams,2);assert.equal(p.counts.newSeries,1);
 assert.equal(p.maps[0].mapNumber,null);assert.equal(p.groups[0].remoteMembershipCompleteness,'unknown');assert.equal(p.importedMaps,0);assert.equal(p.deployable,false);
 assert.notEqual(p.maps[0].replay.payloadSha256,p.maps[0].replay.originalPayloadSha256);assert.equal(p.maps[0].replay.knownAt,null);
});
test('duplicate source receipts do not multiply maps; source-native side or outcome contradiction blocks the group',()=>{
 const f=fixture();f.capture.receipts=[receipt(f),receipt(f,{id:'2'})];assert.equal(run(f).groups[0].knownMapIds.length,1);
 f.capture.receipts.push(receipt(f,{id:'3',radiant_win:'false'}));assert(run(f).maps[0].reasons.includes('MAP_FACTS_CONFLICT'));
 const g=fixture();g.capture.receipts=[receipt(g,{radiant:'12',dire:'11'})];assert(run(g).maps[0].reasons.includes('MAP_FACTS_CONFLICT'));
});
test('unlinked same-day opponent map outside priority set is reviewed, never assigned a series',()=>{
 const f=fixture(),r=structuredClone(f.report.rows[0]);r.matchId='9007199254740994';r.receipt.projection.match_id=r.matchId;r.receipt.projection.series_id=null;
 r.assessment.coverageReasons=['SOURCE_SERIES_UNKNOWN'];r.receipt.projectionSha256=sha(JSON.stringify(r.receipt.projection));f.report.rows.push(r);
 const p=run(f);assert.equal(p.counts.excludedMaps,1);assert.equal(p.reviewGroups[0].automaticMergeAllowed,false);assert.deepEqual(p.reviewGroups[0].unlinkedMapIds,[r.matchId]);
});
test('known local sibling participates in whole-series inventory; missing or unverified sibling blocks',()=>{
 const f=fixture();f.capture.series=[{id:'s',provider:'opendota',provider_series_id:'8',best_of:3,radiant:'12',dire:'11',league:'9'}];
 f.capture.maps=[{id:'2',series_id:'s',provider:'opendota',provider_series_id:'8',radiant:'12',dire:'11',league:'9',started_at:new Date(1788003600*1000).toISOString(),duration_seconds:2000,radiant_win:false,is_pro:true,ingest_state:'accepted'}];
 const p=run(f);assert.equal(p.counts.plannedMaps,1);assert.deepEqual(p.groups[0].knownMapIds,['2','9007199254740993']);assert.equal(p.groups[0].action,'reuse');
 f.capture.maps[0].radiant_win=null;assert(run(f).maps[0].reasons.includes('KNOWN_SIBLING_OUTCOME_UNVERIFIED'));
});
test('canonical identity conflicts and changed numeric ownership cannot be resolved by nickname',()=>{
 for(const change of [f=>f.capture.identities[0].status='provisional',f=>f.capture.players[0].opendota_account_id='999',f=>f.capture.identities.push({...f.capture.identities[0],externalAccountId:'999',observationId:'cross'})]){
  const f=fixture();change(f);assert.equal(run(f).counts.excludedMaps,1);
 }
});
test('unknown heroes, non-pro local league and missing team proof remain explicit blockers',()=>{
 for(const change of [f=>f.capture.references[0].source_payload=[],f=>f.capture.leagues[0].tier='amateur']){
  const f=fixture();change(f);assert.equal(run(f).counts.excludedMaps,1);
 }
 const f=fixture();delete f.report.rows[0].receipt.projection.dire_team;f.report.rows[0].receipt.projectionSha256=sha(JSON.stringify(f.report.rows[0].receipt.projection));assert(run(f).maps[0].reasons.includes('TEAM_PROOF_MISSING'));
});
test('quarantined evidence or differing source-series IDs for one map block all its planned siblings',()=>{
 const f=fixture();f.capture.receipts=[receipt(f,{status:'quarantined'})];assert(run(f).maps[0].reasons.includes('KNOWN_SIBLING_SOURCE_CONFLICT'));
 const g=fixture();g.capture.receipts=[receipt(g,{series_id:'99'})];assert(run(g).maps[0].reasons.includes('MAP_SERIES_CONFLICT'));
});
test('scope changes and changed source bytes cannot silently change the plan',()=>{
 const f=fixture();f.proposal.priorityMapIds=[];assert.throws(()=>run(f),/priority_scope/);
 const g=fixture();g.report.rows[0].receipt.projection.radiant_win=false;assert.throws(()=>run(g),/projection_binding/);
});

