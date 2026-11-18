import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {buildValidationReadiness,writeReadiness,verifyReadiness} from '../../tools/research/post-draft-validation-readiness.mjs';
import {sha} from '../../tools/audits/draft-native-export-core.mjs';
const series=id=>JSON.stringify(['opendota',id]);
function fixture(){return {preparedAt:'2026-11-14T20:00:00.000Z',readAt:'2026-11-14T19:59:59.000Z',candidateSha256:'a'.repeat(64),
  previousExposure:{mapIds:['9007199254740993','1'],canonicalSeriesKeys:[series('1')]},
  maps:[{matchId:'1',seriesKey:series('1')},{matchId:'2',seriesKey:null}],observations:{captures:0,history:0,links:0,bindings:0},
  cachedSchedule:[{page:1,expiresAt:'2026-11-14T19:00:00.000Z'}],catalogueScopes:[]};}

test('minimum exposure union preserves bigint IDs, missing aliases and prior maps absent from DB',()=>{
  const f=fixture(),before=structuredClone(f),r=buildValidationReadiness(f);
  assert.deepEqual(r.exposure.mapIds,['1','2','9007199254740993']);assert.deepEqual(r.exposure.unresolvedLocalMapIds,['2']);
  assert.equal(r.exposure.completeGlobalInventory,false);assert.deepEqual(f,before);
});
test('real captures and a future catalogue entry cannot self-register an independent window',()=>{
  const f=fixture();f.observations={captures:5,history:5,links:5,bindings:5};
  f.catalogueScopes=[{leagueId:'10',eventName:'Synthetic future edition',fromAt:'2026-12-01T00:00:00.000Z',until:'2026-12-10T00:00:00.000Z',recordSha256:'b'.repeat(64)}];
  const r=buildValidationReadiness(f);assert.equal(r.scope.futureCandidates.length,1);assert.equal(r.scope.from,null);
  assert.equal(r.registrationAllowed,false);assert.equal(r.collectionAllowed,false);assert.equal(r.evaluator.allowRealEvaluation,false);
  assert(!r.blockers.includes('REAL_DRAFT_SNAPSHOT_PATH_NOT_EXERCISED'));
  assert(r.blockers.includes('DURABLE_PRESTART_SCORE_PERSISTENCE_NOT_IMPLEMENTED'));
});
test('empty snapshots and stale schedule are explicit; cached pages are never a complete denominator',()=>{
  const r=buildValidationReadiness(fixture());assert(r.blockers.includes('REAL_DRAFT_SNAPSHOT_PATH_NOT_EXERCISED'));
  assert.equal(r.schedule.cachedPages[0].fresh,false);assert.equal(r.schedule.fullPaginationEstablished,false);
});
test('ongoing editions may be reviewed for future series but never silently become registered scope',()=>{
  const f=fixture();f.catalogueScopes=[{leagueId:'10',eventName:'Synthetic current edition',fromAt:'2026-11-01T00:00:00.000Z',until:'2026-12-10T00:00:00.000Z',recordSha256:'b'.repeat(64)}];
  const r=buildValidationReadiness(f);assert.equal(r.scope.futureCandidates.length,0);assert.equal(r.scope.catalogueEntries,1);
  assert.equal(r.scope.ongoingCandidates.length,1);assert.equal(r.scope.from,null);assert.equal(r.registrationAllowed,false);
  assert(!r.blockers.includes('NO_FUTURE_EDITION_IN_LOCAL_TIER1_CATALOGUE'));
});
test('duplicate records, foreign schemas and future read clocks reject rather than produce trusted inventory',()=>{
  for(const change of [f=>f.maps.push(f.maps[0]),f=>f.previousExposure.mapIds.push('1'),f=>f.cachedSchedule.push(f.cachedSchedule[0]),
    f=>f.readAt='2026-11-15T00:00:00.000Z',f=>f.globalComplete=true,f=>f.maps[0].seriesKey='["opendota",1]']){
    const f=fixture();change(f);assert.throws(()=>buildValidationReadiness(f));
  }
});
test('local immutable report replays; overwrite, byte and independently rehashed tampering fail',async()=>{
  const path=`.tools/validation-readiness-test-${randomUUID()}.json`;
  try{
    const saved=await writeReadiness(fixture(),path);assert.deepEqual(await verifyReadiness(path,saved.sha256),saved.result);
    await assert.rejects(writeReadiness(fixture(),path));
    const file=JSON.parse(await readFile(path,'utf8'));file.result.registrationAllowed=true;
    const text=JSON.stringify(file);await writeFile(path,text);
    await assert.rejects(verifyReadiness(path,saved.sha256),/external_sha_mismatch/);
    await assert.rejects(verifyReadiness(path,sha(text)),/replay_mismatch/);
  }finally{await unlink(path).catch(()=>{});}
});
