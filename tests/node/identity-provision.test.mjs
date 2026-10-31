import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeReviewedAccounts,reviewedIdentityEvidence} from '../../packages/db/dist/index.js';
import {assessRegistryIdentityEvidence} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=file=>readFile(new URL('../../'+file,import.meta.url)),json=async file=>JSON.parse(await read(file));
const manifestFile='docs/evidence/s3-01-ti12-identity-provision.manifest.json';
test('review binds exactly ten archived numeric accounts and preserves source/fetch/review clocks',async()=>{
  const m=await json(manifestFile);for(const b of [m.review,m.plan,m.applied,m.replay])assert.equal(sha(await read(b.file)),b.sha256);
  const b=normalizeReviewedAccounts(await json(m.review.file)),r=await json('docs/evidence/s3-01-ti12-registry-evidence.json');
  assert.equal(b.source.reportSha256,sha(await read('docs/evidence/s3-01-ti12-registry-evidence.json')));
  assert.deepEqual(b.accounts,r.proof.members.map(a=>({accountId:a.accountId,steam64:a.steam64,alias:a.alias})));
  assert.equal(b.source.knownAt,'2023-04-11T21:06:28.000Z');assert.equal(b.source.fetchedAt,r.proof.fetchedAt);
  assert.ok(b.reviewedAt>b.source.fetchedAt);assert.equal(b.accounts.length,10);
});
test('applied ledger replays as ten canonical accounts while leaving the historical lineup and training gates unavailable',async()=>{
  const m=await json(manifestFile),r=await json(m.applied.file),p=await json(m.plan.file),b=await json(m.review.file);
  const source=await json(r.sourceReport.file),map=await json(source.mapObservation.file);
  assert.equal(p.plan.status,'ready');assert.equal(p.plan.plannedPlayers,10);assert.equal(p.databaseWrites,0);
  assert.equal(r.status,'applied');assert.equal(r.playersCreated,10);assert.equal(r.accountProofsAdded,10);assert.equal(r.aliasesAdded,10);
  assert.equal(r.identityLedger.registryRevision,'20');assert.equal(r.identityLedger.observations.length,10);
  assert.equal(new Set(r.identityLedger.observations.map(o=>o.claim.playerId)).size,10);
  for(const o of r.identityLedger.observations){const account=b.accounts.find(a=>a.accountId===o.claim.externalAccountId);
    const proof=reviewedIdentityEvidence(b,account,o.claim.playerId).claim;
    assert.equal(o.claim.knownAt,proof.knownAt);assert.equal(o.claim.eventAt,null);assert.equal(o.claim.fetchedAt,proof.fetchedAt);
    assert.equal(o.claim.source,'sha256:'+sha(proof.source));assert.equal(o.claim.evidenceRef,'sha256:'+sha(proof.evidenceRef));}
  assert.deepEqual(assessRegistryIdentityEvidence(source.proof,map,r.identityLedger,r.identityAssessment.snapshotAt),r.identityAssessment);
  assert.equal(r.identityAssessment.canonicalVerifiedAccounts,10);assert.equal(r.identityAssessment.accountsRequiringLinkReview,0);
  assert.equal(r.verifiedMapLineups,0);assert.equal(r.trainingExamples,0);assert.equal(r.strictDatasetStatus,'unavailable');
  assert.equal(r.networkRequests,0);assert.equal(r.deployable,false);
});
test('actual second application performs zero inserts and keeps canonical IDs and revision stable',async()=>{
  const m=await json(manifestFile),first=await json(m.applied.file),again=await json(m.replay.file);
  assert.equal(again.status,'already_applied');assert.equal(again.databaseWrites,0);
  assert.equal(again.playersCreated+again.accountProofsAdded+again.aliasesAdded,0);
  assert.deepEqual(again.planAfter,first.planAfter);assert.equal(again.identityLedger.registryRevision,'20');
  assert.deepEqual(again.identityLedger.observations,first.identityLedger.observations);
  assert.equal(again.identityAssessment.canonicalVerifiedAccounts,10);
});
test('CLI refuses overwrite, bad arguments and a tampered plan before connecting to DB',async()=>{
  const file='docs/evidence/s3-01-ti12-identity-plan.json',before=await read(file);
  for(const [args,status] of [[['preview','--out',file],2],[['preview','--out','../outside.json'],2],
    [['apply','--plan',file,'--sha256','0'.repeat(64),'--out','reports/rejected-identity-test.json'],1]]){
    const child=spawnSync(process.execPath,['scripts/provision-identity.mjs',...args],{
      cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,DATABASE_URL:'synthetic-secret-not-a-database'}});
    assert.equal(child.status,status);assert.equal(child.stdout,'');assert.doesNotMatch(child.stderr,/synthetic-secret|SELECT|INSERT|postgres:/);
  }
  assert.equal(sha(await read(file)),sha(before));
});
