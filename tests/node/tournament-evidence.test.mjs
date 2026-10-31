import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>readFile(new URL('../../'+path,import.meta.url));
test('saved TI12 evidence is byte-bound and proves only archived league/registration metadata',async()=>{
  const manifest=JSON.parse(await read('docs/evidence/s3-01-ti12-evidence.manifest.json'));
  const bytes=await read(manifest.report.file),report=JSON.parse(bytes);
  assert.equal(sha(bytes),manifest.report.sha256);assert.equal(report.mode,'live_archived_ti12_metadata');
  assert.equal(report.captureStatus,'complete');assert.equal(report.requests.attempts,2);
  assert.equal(report.proof.knownByAt,'2023-10-07T10:14:10.000Z');
  assert.equal(report.proof.scope,'event_league_registration_metadata_only');
  assert.equal(report.proof.metadataSha256,manifest.metadataSha256);
  assert.equal(sha(await read(report.cohort.file)),report.cohort.sha256);
  assert.equal(report.coverage.uniqueMaps,5);assert.equal(report.coverage.mapsWithMatchingLeagueReference,5);
  assert.equal(new Set(report.coverage.maps.map(m=>m.matchId)).size,5);
  for(const row of report.coverage.maps){assert.equal(row.strictTrainingEligible,false);assert.ok(row.missingEvidence.includes('MAP_LINEUP_KNOWN_AT'));}
  for(const key of ['lineupKnownAt','accountLinksKnownAt','mapSidesKnownAt','patchReleaseKnownAt','draftKnownAt'])assert.equal(report.proof[key],null);
  assert.equal(report.trainingExamples,0);assert.equal(report.databaseWrites,0);assert.equal(report.deployable,false);
  assert.doesNotMatch(bytes.toString(),/SESSION_ID|PAGE_LOAD_ID|Set-Cookie|synthetic-private/);
});
test('registration shell and timed-out endpoint probes remain unresolved, never roster evidence',async()=>{
  const manifest=JSON.parse(await read('docs/evidence/s3-01-ti12-evidence.manifest.json'));
  const bytes=await read(manifest.probes.file),probes=JSON.parse(bytes);
  assert.equal(sha(bytes),manifest.probes.sha256);assert.equal(probes.sources.length,3);
  assert.ok(probes.sources.every(s=>s.digestVerified&&s.originalAndMementoVerified));
  const registration=probes.sources.find(s=>s.id==='registration_page');
  assert.equal(registration.renderedNicknameSlots,5);assert.equal(registration.nonemptyNicknameSlots,0);
  assert.equal(registration.scope,'registration_search_interface_only');
  assert.equal(probes.unresolvedArchiveQueries.length,2);assert.ok(probes.unresolvedArchiveQueries.every(q=>q.status==='timeout'));
  assert.equal(probes.verifiedMapLineups,0);assert.equal(probes.canonicalAccountLinksCreated,0);assert.equal(probes.trainingExamples,0);
});
test('cohort CLI refuses existing evidence and bad arguments before requests, preserving captured bytes',async()=>{
  const file='docs/evidence/s3-01-ti12-evidence.json',before=await read(file);
  for(const args of [['--out',file],['--out','../outside.json'],['--url','https://example.invalid']]){
    const child=spawnSync(process.execPath,['scripts/audit-cohort-evidence.mjs',...args],{
      cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,DATABASE_URL:'synthetic-secret-not-used'}});
    assert.equal(child.status,2);assert.equal(child.stdout,'');assert.doesNotMatch(child.stderr,/synthetic-secret-not-used|https:\/\/example/);
  }
  assert.equal(sha(await read(file)),sha(before));
});
test('actual archived registration preserves five public aliases without identifying canonical players or a map lineup',async()=>{
  const manifest=JSON.parse(await read('docs/evidence/s3-01-ti12-registration.manifest.json'));
  const bytes=await read(manifest.file),report=JSON.parse(bytes);
  assert.equal(sha(bytes),manifest.sha256);assert.equal(report.proof.knownByAt,'2023-10-01T08:39:37.000Z');
  assert.equal(report.proof.teamId,'8291895');assert.equal(report.proof.registeredRows,5);
  assert.equal(report.retrospectiveLookupSelection.matchId,'7378530387');
  assert.equal(report.retrospectiveLookupSelection.knownAt,null);
  assert.equal(report.proof.mapId,null);assert.equal(report.proof.mapSide,null);
  assert.ok(report.proof.entries.every(row=>row.canonicalPlayerId===null&&row.externalAccountId===null));
  assert.equal(report.proof.verifiedCanonicalPlayers,0);assert.equal(report.verifiedMapLineups,0);
  assert.equal(report.trainingExamples,0);assert.equal(report.indexes[1].status,'no_snapshot_in_this_exact_query');
  assert.doesNotMatch(bytes.toString(),/full_name|SESSION_ID|Set-Cookie/);
});
