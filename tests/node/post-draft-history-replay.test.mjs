import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../../tools/research/post-draft-dataset.mjs';
import {parseSource} from '../../packages/ingestion/dist/index.js';
import {createProjectionReplay,assertIsolatedTarget,validateDryRunScope,REPLAY_ADAPTER} from '../../tools/research/post-draft-history-replay.mjs';

// Synthetic test-only observations, never used by the real dry-run CLI.
const fixture=()=>{
 const id='9007199254740993',source={provider:'opendota',endpoint:`/matches/${id}`,adapterVersion:'original-test',payloadSha256:'a'.repeat(64),fetchedAt:'2026-11-13T00:00:00.000Z',knownAt:null};
 const projection={match_id:id,start_time:1788000000,duration:2000,radiant_win:true,leagueid:9,series_id:8,series_type:1,radiant_team_id:11,dire_team_id:12,
  players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,account_id:100+i,hero_id:i+1}))};
 const hash=sha(JSON.stringify(projection)),members=projection.players.map(p=>({slot:p.player_slot,accountId:String(p.account_id),heroId:p.hero_id}));
 const receipt={projection,projectionSha256:hash,source,sourceIssues:[],originalResponseBytesRetained:false};
 const report={rows:[{matchId:id,status:'observed',assessment:{sourceConsistent:true,coverageReasons:[]},receipt}]};
 const plan={status:'requires_isolated_dry_run',deployable:false,maps:[{matchId:id,status:'planned_for_isolated_dry_run',reasons:[],members,source:structuredClone(source),projectionSha256:hash,
  replay:{adapterVersion:REPLAY_ADAPTER,payloadSha256:hash,originalPayloadSha256:source.payloadSha256,knownAt:null,originalResponseBytesRetained:false}}]};
 const proposal={scope:'isolated_test_database_only',providerHttpAllowed:false,workingDatabaseWritesAllowed:false,trainingAllowed:false,activationAllowed:false,mapIds:[id]};
 const capture={references:[{id:'1',endpoint:'/heroes',adapter_version:'original-test',payload_sha256:'b'.repeat(64),fetched_at:source.fetchedAt,source_payload:members.map(m=>({id:m.heroId,name:'test_'+m.heroId,localized_name:'Test'}))},
 {id:'2',endpoint:'/leagues',adapter_version:'original-test',payload_sha256:'c'.repeat(64),fetched_at:source.fetchedAt,source_payload:[{leagueid:'9',name:'Synthetic',tier:'professional'}]}]};
 return {id,proposal,plan,report,capture};
};
const replay=f=>createProjectionReplay(f.proposal,f.plan,f.report,f.capture);

test('projection has its own valid hash, explicit adapter and separate original provenance; bigint and native slots preserved',async()=>{
 const f=fixture(),r=replay(f),o=await r.provider.getMatchSource(f.id),parsed=parseSource(o,f.id);
 assert.equal(parsed.match.match_id,f.id);assert.equal(o.source.adapterVersion,REPLAY_ADAPTER);assert.notEqual(o.source.payloadSha256,r.lineage[0].originalSource.payloadSha256);
 assert.equal(o.source.fetchedAt,r.lineage[0].originalSource.fetchedAt);assert.equal(o.source.knownAt,null);assert.equal(o.source.attempts,0);
 assert.deepEqual(parsed.match.players.map(p=>p.player_slot),[0,1,2,3,4,128,129,130,131,132]);
 assert.equal(r.lineage[0].originalResponseBytesRetained,false);
});
test('offline adapter rejects unplanned IDs and returns independent copies',async()=>{
 const f=fixture(),r=replay(f);await assert.rejects(r.provider.getMatchSource('2'),/map_outside_plan/);
 (await r.provider.getMatchSource(f.id)).source.knownAt='bad';assert.equal((await r.provider.getMatchSource(f.id)).source.knownAt,null);
 (await r.provider.getHeroes()).data.length=0;assert.equal((await r.provider.getHeroes()).data.length,10);
 assert.equal((await r.provider.getLeagues()).data[0].tier,'professional');
});
test('changed bytes, original hash, timestamp and unsupported replay label are refused',()=>{
 for(const change of [f=>f.report.rows[0].receipt.projection.radiant_win=false,f=>f.plan.maps[0].replay.originalPayloadSha256='d'.repeat(64),
  f=>f.report.rows[0].receipt.source.fetchedAt='2025-01-01T00:00:00.000Z',f=>f.plan.maps[0].replay.adapterVersion='original-test']){
  const f=fixture();change(f);assert.throws(()=>replay(f));
 }
});
test('selected slots/accounts/heroes must match the plan, and duplicate members are refused',()=>{
 for(const field of ['slot','accountId','heroId']){const f=fixture();f.plan.maps[0].members[0][field]=f.plan.maps[0].members[1][field];assert.throws(()=>replay(f));}
 const f=fixture();f.report.rows.push(structuredClone(f.report.rows[0]));assert.throws(()=>replay(f));
});
test('excluded, reordered, duplicate or expanded scope and live mutation flags are refused',()=>{
 for(const change of [f=>f.proposal.mapIds.push('2'),f=>f.proposal.mapIds.push(f.id),f=>f.plan.maps[0].reasons.push('blocked'),f=>f.plan.maps[0].status='excluded_pending_review',
  f=>f.proposal.workingDatabaseWritesAllowed=true,f=>f.proposal.providerHttpAllowed=true,f=>f.proposal.trainingAllowed=true,f=>f.proposal.activationAllowed=true]){
  const f=fixture();change(f);assert.throws(()=>validateDryRunScope(f.proposal,f.plan));
 }
});
test('invalid source, known-at invention and invalid cached catalogues cannot be replayed',()=>{
 for(const change of [f=>f.report.rows[0].receipt.sourceIssues.push('SOURCE_SCHEMA_INVALID'),f=>f.report.rows[0].assessment.coverageReasons.push('unknown'),
  f=>f.plan.maps[0].replay.knownAt='2020-01-01T00:00:00.000Z',f=>f.capture.references[0].source_payload[0].id=-1,f=>f.capture.references.pop()]){
  const f=fixture();change(f);assert.throws(()=>replay(f));
 }
});
test('target guard accepts only the generated local clone on the exact source connection',()=>{
 const name='codex_s304_dry_0123456789abcdef',source='postgresql://test:test@localhost:5432/working',target='postgresql://test:test@localhost:5432/'+name;
 assertIsolatedTarget(source,target,name,name);
 for(const args of [[source,source,name,'working'],[target,target,name,name],[source,target,'working',name],[source,target,name,'working'],
  [source,target.replace('localhost','remote.example'),name,name],[source.replace('localhost','remote.example'),target,name,name],[source,target.replace('5432','5433'),name,name]])assert.throws(()=>assertIsolatedTarget(...args));
});
