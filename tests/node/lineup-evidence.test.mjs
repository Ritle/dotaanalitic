import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditLeagueLineupEvidence} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=file=>readFile(new URL('../../'+file,import.meta.url)),json=async file=>JSON.parse(await read(file));
const manifestFile='docs/evidence/s3-01-ti12-lineup-evidence.manifest.json';

test('dated official tournament registration binds ten numeric accounts without claiming map attendance',async()=>{
  const m=await json(manifestFile);for(const b of [m.report,m.probes,m.identityLedger,m.mapObservation])assert.equal(sha(await read(b.file)),b.sha256);
  const r=await json(m.report.file);for(const b of [r.mapObservation,r.identityLedger,r.previousEvidenceManifest])assert.equal(sha(await read(b.file)),b.sha256);
  assert.equal(r.captureStatus,'complete');assert.deepEqual(r.errors,[]);assert.equal(r.requests.attempts,3);
  assert.equal(r.registration.sourceRegisteredPlayers,100);assert.equal(r.registration.members.length,10);
  assert.equal(r.registration.knownByAt,'2023-10-07T10:14:14.000Z');assert.equal(r.registration.registrationPeriod,8);
  assert.equal(r.registration.nodeCount,70);assert.deepEqual(r.registration.relevantNodes,[]);
  assert.equal(r.registration.scope,'tournament_registration_not_map_lineup');
  assert.equal(r.actual.players.length,10);assert.equal(r.actual.knownAt,null);assert.equal(r.actual.availability,'retrospective_fact');
  assert.equal(r.review.exactRegisteredFives,2);assert.equal(r.review.mapCount,1);
  assert.doesNotMatch(JSON.stringify(r),/"(?:kills|deaths|assists|hero_id|heroId|duration|match_outcome|radiant_score|dire_score|prize_pool|admins|streams)"|Set-Cookie|DATABASE_URL/);
});

test('frozen revision20 resolves ten participants while strict map lineup remains unavailable',async()=>{
  const m=await json(manifestFile),r=await json(m.report.file),map=await json(r.mapObservation.file),applied=await json(r.identityLedger.file);
  assert.deepEqual(auditLeagueLineupEvidence(r.registration,r.actual,map,applied.identityLedger,r.generatedAt),r.review);
  assert.equal(r.review.ledgerRevision,'20');assert.equal(r.review.canonicalParticipants,10);assert.equal(r.review.providerAgreementRows,10);
  assert.equal(r.review.registeredBeforeCutoff,10);assert.ok(r.review.players.every(p=>p.canonicalPlayerId!==null));
  assert.equal(r.review.strictMapLineupStatus,'unavailable');assert.equal(r.review.actualKnownAt,null);
  assert.deepEqual(r.review.strictReasons,['REGISTRATION_DOES_NOT_PROVE_MAP_ATTENDANCE','ACTUAL_NATIVE_SLOTS_KNOWN_AT_UNPROVEN']);
  assert.equal(r.verifiedMapLineups,0);assert.equal(r.trainingExamples,0);assert.equal(r.trainingReady,false);assert.equal(r.deployable,false);
  assert.equal(r.databaseWrites,0);assert.equal(m.workingState.identity_revision,'20');assert.equal(m.workingState.datasets,0);
});

test('bounded archive discovery preserves negative-query scope and raw replay agrees with live capture',async()=>{
  const m=await json(manifestFile),p=await json(m.probes.file),r=await json(m.report.file);
  assert.equal(p.indexes.length,5);assert.equal(p.indexes.filter(i=>i.rows.length===0).length,4);
  assert.ok(p.indexes.every(i=>i.globalAbsenceProven===false));assert.equal(p.globalAbsenceProven,false);
  assert.deepEqual(m.rawReplay,{registration:{samePayload:true,sameProjection:true},actual:{samePayload:true,sameProjection:true}});
  for(const key of ['registration','actual'])assert.equal(p[key].projectionSha256,r[key].projectionSha256);
  const map=await json(r.mapObservation.file),applied=await json(r.identityLedger.file);
  assert.deepEqual(auditLeagueLineupEvidence(p.registration,p.actual,map,applied.identityLedger,p.reviewSnapshotAt),p.review);
  assert.equal(m.networkAttempts,10);assert.deepEqual(m.httpStatuses,{'200':10});assert.equal(m.verifiedMapLineups,0);
});

test('lineup CLI refuses overwrite and invalid destinations before network',async()=>{
  const file='docs/evidence/s3-01-ti12-lineup-evidence.json',before=await read(file);
  for(const args of [['--out',file],['--out','../outside.json'],['--url','https://example.invalid']]){
    const child=spawnSync(process.execPath,['scripts/audit-lineup-evidence.mjs',...args],{
      cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,DATABASE_URL:'synthetic-secret-not-used'}});
    assert.equal(child.status,2);assert.equal(child.stdout,'');assert.doesNotMatch(child.stderr,/synthetic-secret-not-used|https:\/\/example/);
  }
  assert.equal(sha(await read(file)),sha(before));
});
