import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditHistoricalMapAccounts} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=file=>readFile(new URL('../../'+file,import.meta.url));
const json=async file=>JSON.parse(await read(file));
const manifestFile='docs/evidence/s3-01-ti12-account-evidence.manifest.json';
test('archived team account evidence has byte-bound provenance and no canonical or map-lineup promotion',async()=>{
  const manifest=await json(manifestFile);
  for(const bound of [manifest.report,manifest.probes,manifest.mapObservation])assert.equal(sha(await read(bound.file)),bound.sha256);
  const report=await json(manifest.report.file),map=await json(manifest.mapObservation.file);
  assert.equal(sha(await read(map.selectionEvidence.file)),map.selectionEvidence.sha256);
  assert.equal(report.captureStatus,'complete');assert.equal(report.requests.attempts,4);assert.deepEqual(report.errors,[]);
  assert.equal(report.proofs.reduce((n,p)=>n+p.members.length,0),13);
  assert.equal(report.proofs.reduce((n,p)=>n+p.registeredAccountIds.length,0),10);
  assert.deepEqual(report.proofs.map(p=>p.knownByAt),['2022-08-16T12:19:30.000Z','2022-08-05T02:04:35.000Z']);
  for(const p of report.proofs){
    assert.equal(p.accountNamespace,'steam32');assert.ok(p.members.every(m=>m.canonicalPlayerId===null));
    assert.equal(p.autoIdentityMergeEligible,false);assert.equal(p.sourceJoinedAtIsKnownAt,false);
    assert.equal(p.projectionSha256,sha(JSON.stringify({teamId:p.teamId,members:p.members,registeredAccountIds:p.registeredAccountIds})));
  }
  assert.equal(map.knownAt,null);assert.equal(report.databaseWrites,0);
  assert.equal(report.canonicalPlayersCreated,0);assert.equal(report.verifiedMapLineups,0);
  assert.equal(report.trainingExamples,0);assert.equal(report.deployable,false);
  assert.doesNotMatch(JSON.stringify(report),/real_name|member_stats|SESSION_ID|Set-Cookie/);
});
test('offline replay counts six exact accounts on one map, never thirteen historical members or ten training examples',async()=>{
  const manifest=await json(manifestFile),report=await json(manifest.report.file),map=await json(manifest.mapObservation.file);
  const coverage=auditHistoricalMapAccounts(report.proofs,map,report.generatedAt);
  assert.deepEqual(coverage,report.coverage);
  assert.deepEqual(auditHistoricalMapAccounts([...report.proofs].reverse().concat(report.proofs),
    {...map,players:[...map.players].reverse()},report.generatedAt),coverage);
  assert.equal(coverage.mapCount,1);assert.equal(coverage.observedPlayerRows,10);assert.equal(coverage.accountsObservedBeforeCutoff,6);
  assert.equal(coverage.accountsWithoutMatchingArchive,4);assert.equal(coverage.unknownAccountRows,0);
  assert.equal(coverage.trainingExamples,0);assert.equal(coverage.strictDatasetStatus,'unavailable');
  assert.deepEqual(coverage.players.filter(p=>p.accountEvidenceStatus==='no_matching_archive').map(p=>p.accountId),
    ['94054712','346412363','136829091','184620877']);
});
test('empty exact archive queries and current response are not global absence or historical proof',async()=>{
  const manifest=await json(manifestFile),probes=await json(manifest.probes.file);
  assert.equal(probes.indexes.length,10);assert.equal(probes.indexes.filter(i=>i.rows.length===0).length,8);
  assert.ok(probes.indexes.every(i=>i.globalAbsenceProven===false));
  const profiles=probes.indexes.filter(i=>i.kind==='player_info_all_history');
  assert.equal(profiles.length,4);assert.ok(profiles.every(i=>i.rows.length===0&&!Object.hasOwn(i.queryParameters,'from')));
  assert.ok(probes.rawReplay.every(p=>p.digestVerified&&p.originalAndMementoVerified&&p.agreesWithIndependentCliCapture));
  assert.equal(probes.currentTeamResponse.knownAt,null);assert.equal(probes.currentTeamResponse.usedAsHistoricalProof,false);
  assert.equal(probes.totalDirectAttempts,18);assert.equal(probes.trainingExamples,0);
});
test('account CLI refuses existing output and invalid paths before any requests without disclosing secrets',async()=>{
  const file='docs/evidence/s3-01-ti12-account-evidence.json',before=await read(file);
  for(const args of [['--out',file],['--out','../outside.json'],['--url','https://example.invalid']]){
    const child=spawnSync(process.execPath,['scripts/audit-account-evidence.mjs',...args],{
      cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,DATABASE_URL:'synthetic-secret-not-used'}});
    assert.equal(child.status,2);assert.equal(child.stdout,'');assert.doesNotMatch(child.stderr,/synthetic-secret-not-used|https:\/\/example/);
  }
  assert.equal(sha(await read(file)),sha(before));
});
