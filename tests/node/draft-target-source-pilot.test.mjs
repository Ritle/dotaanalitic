import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedBody,firstGameId,safeId,shouldStop,stratzQuery} from '../../tools/audits/draft-target-source-pilot.mjs';
import {inspectPanda,inspectStratz,summarize} from '../../tools/audits/draft-target-source-report.mjs';

test('provider IDs reject unsafe numbers and injected paths',()=>{
  assert.equal(safeId(9070527945),'9070527945');
  assert.equal(safeId(Number.MAX_SAFE_INTEGER+1),null);
  for(const value of ['../1','1?token=x','1) { secrets }',0,-1,null])assert.equal(safeId(value),null);
});
test('probe game selection does not derive ordinal or native ID',()=>{
  assert.equal(firstGameId({games:[{id:9,position:3},{id:4,position:1}]}),'9');
  assert.equal(firstGameId({games:[{id:null},{id:'4'}]}),'4');
  assert.equal(firstGameId({games:[]}),null);
  assert.equal(firstGameId({games:Array.from({length:21},()=>({id:1}))}),null);
});
test('bounded JSON body rejects overflow, credentials and malformed payload',async()=>{
  assert.equal((await boundedBody(new Response('{"ok":true}'),11)).toString(),'{"ok":true}');
  await assert.rejects(boundedBody(new Response('{"ok":true}'),10),/response_too_large/);
  await assert.rejects(boundedBody(new Response('{"error":"private-token"}'),100,['private-token']),/unsafe_payload/);
  await assert.rejects(boundedBody(new Response('<html>error</html>'),100));
});
test('auth, plan, quota and transient errors stop PandaScore expansion',()=>{
  for(const code of [401,403,429,500,503])assert.equal(shouldStop(code),true);
  assert.equal(shouldStop(200),false);
});
test('one STRATZ query contains only the fixed three unique native IDs',()=>{
  const query=stratzQuery(['9070527945','9068910292','9067177642']);
  assert.equal((query.match(/match\(id:/g)??[]).length,3);
  assert.ok(!query.includes('position'));
  assert.throws(()=>stratzQuery(['1','1','2']));
  assert.throws(()=>stratzQuery(['1','2','3) { id }']));
});

const pandaFixture=()=>({id:123,games:[{id:701,match_id:123,position:2},{id:700,match_id:123,position:1}]});
test('explicit positions survive reversed transport order without a native binding',()=>{
  const result=inspectPanda(pandaFixture(),'123');
  assert.equal(result.explicitPositions,2);
  assert.deepEqual(result.games.map(g=>g.position),[2,1]);
  assert.equal(result.nativeMapBindings,0);
  assert.ok(result.games.every(g=>g.nativeDotaMapId===null&&!g.gameplayStartVerified));
});
test('wrong parent, duplicate ordinal, missing position and unsafe ID fail closed',()=>{
  for(const alter of [p=>p.id=124,p=>p.games[0].match_id=124,p=>p.games[0].position=1,
    p=>delete p.games[0].position,p=>p.games[0].id=Number.MAX_SAFE_INTEGER+1]){
    const fixture=pandaFixture();alter(fixture);const result=inspectPanda(fixture,'123');
    assert.equal(result.validSummary,false);assert.equal(result.explicitPositions,0);
  }
});
test('empty and missing summaries never invent sample counts',()=>{
  assert.equal(inspectPanda({id:123,games:[]},'123').explicitPositions,0);
  const result=summarize({pandaSample:[{id:'123'}],stratzSample:['1']},{requests:[]},{});
  assert.equal(result.counts.explicitPandaPositions,0);assert.equal(result.counts.stratzSeriesMemberships,0);
  assert.equal(result.primaryEligible,false);assert.equal(result.deployable,false);
});
test('series membership does not turn array order into map ordinal',()=>{
  const payload={data:{m0:{id:1,seriesId:9,startDateTime:100,series:{id:9,matches:[{id:2,seriesId:9},{id:1,seriesId:9}]}}}};
  const row=inspectStratz(payload,['1'])[0];assert.equal(row.seriesMembershipObserved,true);
  assert.equal(row.explicitMapNumber,null);assert.equal(row.pandaMatchId,null);assert.equal(row.gameplayStartVerified,false);
  payload.data.m0.series.matches[0].seriesId=8;
  assert.equal(inspectStratz(payload,['1'])[0].seriesMembershipObserved,false);
});
test('GraphQL partial error, duplicate members and absent target reject membership',()=>{
  for(const payload of [
    {errors:[{message:'partial'}],data:{m0:{id:1,seriesId:9,series:{id:9,matches:[{id:1,seriesId:9}]}}}},
    {data:{m0:{id:1,seriesId:9,series:{id:9,matches:[{id:1,seriesId:9},{id:1,seriesId:9}]}}}},
    {data:{m0:{id:1,seriesId:9,series:{id:9,matches:[{id:2,seriesId:9}]}}}}
  ])assert.equal(inspectStratz(payload,['1'])[0].seriesMembershipObserved,false);
});
