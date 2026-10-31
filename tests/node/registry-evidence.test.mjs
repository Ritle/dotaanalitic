import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assessRegistryIdentityEvidence} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=file=>readFile(new URL('../../'+file,import.meta.url)),json=async file=>JSON.parse(await read(file));
const manifestFile='docs/evidence/s3-01-ti12-registry-evidence.manifest.json';

test('archived registry projects ten fixed map accounts without treating all registry rows as map examples',async()=>{
  const m=await json(manifestFile);for(const b of [m.report,m.probes,m.identityLedger,m.mapObservation])assert.equal(sha(await read(b.file)),b.sha256);
  const r=await json(m.report.file);for(const b of [r.mapObservation,r.identityLedger,r.previousEvidenceManifest])assert.equal(sha(await read(b.file)),b.sha256);
  assert.equal(r.captureStatus,'complete');assert.deepEqual(r.errors,[]);assert.equal(r.requests.attempts,2);
  assert.equal(r.proof.sourceRowCount,2877);assert.equal(r.proof.members.length,10);assert.equal(r.proof.knownByAt,'2023-04-11T21:06:28.000Z');
  assert.equal(r.proof.projectionSha256,sha(JSON.stringify({requestedAccountIds:r.proof.requestedAccountIds,members:r.proof.members})));
  assert.ok(r.proof.members.every(p=>BigInt(p.steam64)-76561197960265728n===BigInt(p.accountId)));
  assert.ok(r.proof.members.every(p=>p.reportedPro===true&&p.reportedLocked===true));
  assert.equal(r.proof.members.find(p=>p.accountId==='184620877').alias,'kasane');
  // Old organization membership is preserved; it cannot be substituted for the native map lineup.
  assert.equal(r.proof.members.find(p=>p.accountId==='94054712').reportedTeamId,'8944337');
  assert.equal(r.review.mapCount,1);assert.equal(r.trainingExamples,0);assert.equal(r.deployable,false);
  assert.doesNotMatch(JSON.stringify(r),/last_login|personaname|avatar|profileurl|loccountrycode|Set-Cookie|DATABASE_URL/);
});

test('frozen empty ledger review is reproducible with the existing resolver and does not create canonical links',async()=>{
  const m=await json(manifestFile),r=await json(m.report.file),map=await json(r.mapObservation.file),ledger=await json(r.identityLedger.file);
  assert.deepEqual(assessRegistryIdentityEvidence(r.proof,map,ledger,r.generatedAt),r.review);
  assert.deepEqual(assessRegistryIdentityEvidence(r.proof,{...map,players:[...map.players].reverse()},ledger,r.generatedAt),r.review);
  assert.equal(ledger.registryRevision,'0');assert.deepEqual(ledger.observations,[]);
  assert.deepEqual(ledger.databaseCounts,{canonicalPlayers:0,accountClaims:0,legacyLinks:0});
  assert.equal(r.review.registryObservedAccounts,10);assert.equal(r.review.canonicalVerifiedAccounts,0);
  assert.equal(r.review.accountsRequiringLinkReview,10);assert.equal(r.review.ledgerObservedAt,ledger.observedAt);
  assert.ok(r.review.players.every(p=>p.canonicalPlayerId===null&&p.canonicalStatus==='unknown'));
  assert.equal(r.verifiedMapLineups,0);assert.equal(r.strictDatasetStatus,'unavailable');assert.equal(r.databaseWrites,0);
});

test('bounded discovery records eight then ten source matches and preserves empty-query scope',async()=>{
  const m=await json(manifestFile),p=await json(m.probes.file),r=await json(m.report.file);
  assert.equal(p.indexes.length,3);assert.equal(p.indexes[0].rows.length,0);assert.ok(p.indexes.every(i=>i.globalAbsenceProven===false));
  assert.deepEqual(p.snapshots.map(s=>s.proof.members.length),[8,10]);
  assert.deepEqual(p.snapshots[0].proof.missingAccountIds,['184620877','346412363']);
  assert.equal(p.snapshots[1].proof.payloadSha256,r.proof.payloadSha256);assert.equal(p.snapshots[1].proof.projectionSha256,r.proof.projectionSha256);
  assert.equal(m.finalRawReplay.samePayload,true);assert.equal(m.finalRawReplay.sameProjection,true);
  assert.equal(m.networkAttempts,7);assert.deepEqual(m.httpStatuses,{'200':7});assert.equal(m.canonicalVerifiedAccounts,0);
});

test('identity CLI rejects overwrite and invalid destinations before network without exposing environment',async()=>{
  const file='docs/evidence/s3-01-ti12-registry-evidence.json',before=await read(file);
  for(const args of [['--out',file],['--out','../outside.json'],['--url','https://example.invalid']]){
    const child=spawnSync(process.execPath,['scripts/audit-identity-evidence.mjs',...args],{
      cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,DATABASE_URL:'synthetic-secret-not-used'}});
    assert.equal(child.status,2);assert.equal(child.stdout,'');assert.doesNotMatch(child.stderr,/synthetic-secret-not-used|https:\/\/example/);
  }
  assert.equal(sha(await read(file)),sha(before));
});
