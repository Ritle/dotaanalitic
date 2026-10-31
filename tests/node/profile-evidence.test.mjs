import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditHistoricalAccountSources} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=file=>readFile(new URL('../../'+file,import.meta.url)),json=async file=>JSON.parse(await read(file));
const manifestFile='docs/evidence/s3-01-ti12-profile-evidence.manifest.json';
test('Steam profile capture binds three numeric IDs to dated self-published profiles without canonical identities',async()=>{
  const m=await json(manifestFile);for(const bound of [m.report,m.liveCapture,m.probes,m.lookupPlan])assert.equal(sha(await read(bound.file)),bound.sha256);
  const r=await json(m.report.file);assert.equal(sha(await read(r.previousEvidence.file)),r.previousEvidence.sha256);
  assert.equal(sha(await read(r.mapObservation.file)),r.mapObservation.sha256);
  assert.equal(r.verificationStatus,'verified_saved_bytes');assert.equal(r.networkRequests,0);
  const live=await json(m.liveCapture.file);assert.equal(live.captureStatus,'partial_or_blocked');assert.equal(live.requests.attempts,7);
  assert.deepEqual(live.errors,[{accountId:'346412363',code:'archive_http_error',status:302}]);
  assert.equal(live.coverage.accountsObservedBeforeCutoff,8);assert.equal(live.proofs.length,2);
  assert.deepEqual(r.proofs.map(p=>p.accountId),['94054712','346412363','136829091']);
  assert.deepEqual(r.proofs.map(p=>p.knownByAt),['2013-12-19T08:17:42.000Z','2022-09-14T11:06:06.000Z','2019-10-14T14:41:09.000Z']);
  for(const p of r.proofs){assert.equal(p.verifiedPersonIdentity,false);assert.equal(p.canonicalPlayerId,null);assert.equal(p.teamId,null);
    assert.equal(p.projectionSha256,sha(JSON.stringify({accountId:p.accountId,steam64:p.steam64,alias:p.alias})));}
  assert.equal(r.trainingExamples,0);assert.equal(r.databaseWrites,0);assert.equal(r.deployable,false);
  assert.doesNotMatch(JSON.stringify(r),/g_sessionID|summary|real_name|Set-Cookie/);
});
test('offline mixed-source replay yields nine observed IDs on one map, with one unresolved and no eligible lineup',async()=>{
  const m=await json(manifestFile),r=await json(m.report.file),previous=await json(r.previousEvidence.file),map=await json(r.mapObservation.file);
  const replay=auditHistoricalAccountSources(previous.proofs,r.proofs,map,r.generatedAt);assert.deepEqual(replay,r.coverage);
  assert.deepEqual(auditHistoricalAccountSources([...previous.proofs].reverse(),[...r.proofs].reverse().concat(r.proofs),
    {...map,players:[...map.players].reverse()},r.generatedAt),replay);
  assert.equal(replay.mapCount,1);assert.equal(replay.organizationObservedAccounts,6);assert.equal(replay.profileOnlyAccounts,3);
  assert.equal(replay.accountsObservedBeforeCutoff,9);assert.equal(replay.accountsWithoutMatchingArchive,1);
  assert.deepEqual(replay.players.filter(p=>!p.observedBeforeCutoff).map(p=>p.accountId),['184620877']);
  assert.equal(replay.verifiedMapLineups,0);assert.equal(replay.trainingExamples,0);assert.equal(replay.strictDatasetStatus,'unavailable');
});
test('current redirects only locate archives; empty queries never prove global absence',async()=>{
  const m=await json(manifestFile),probes=await json(m.probes.file);
  assert.equal(probes.indexes.length,8);assert.equal(probes.indexes.filter(i=>i.rows.length===0).length,5);
  assert.ok(probes.indexes.every(i=>i.globalAbsenceProven===false));
  assert.equal(probes.redirects.length,2);assert.ok(probes.redirects.every(r=>r.knownAt===null&&r.historicalIdentityProven===false));
  assert.equal(m.finalRawReplay.length,3);assert.ok(m.finalRawReplay.every(p=>p.samePayload&&p.sameProjection));
  assert.equal(m.networkAttempts,27);assert.equal(m.httpStatuses['200'],24);assert.equal(m.httpStatuses['302'],3);
});
test('profile CLI refuses existing output and invalid destinations before network and preserves evidence bytes',async()=>{
  const file='docs/evidence/s3-01-ti12-profile-evidence.json',before=await read(file);
  for(const args of [['--out',file],['--out','../outside.json'],['--url','https://example.invalid']]){
    const child=spawnSync(process.execPath,['scripts/audit-profile-evidence.mjs',...args],{
      cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,DATABASE_URL:'synthetic-secret-not-used'}});
    assert.equal(child.status,2);assert.equal(child.stdout,'');assert.doesNotMatch(child.stderr,/synthetic-secret-not-used|https:\/\/example/);
  }
  assert.equal(sha(await read(file)),sha(before));
});
