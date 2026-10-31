import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file=new URL('../../reports/s1-07-valve-source-manifest.json',import.meta.url),manifest=JSON.parse(await readFile(file,'utf8'));
const reportBody=await readFile(new URL('../../'+manifest.reportFile,import.meta.url)),report=JSON.parse(reportBody);
test('saved live Valve evidence is byte-bound and remains a review capture without model or registry eligibility',()=>{
  assert.equal(createHash('sha256').update(reportBody).digest('hex'),manifest.reportSha256);
  assert.equal(report.mode,'live_valve_primary_sources');assert.equal(report.captureStatus,'complete');assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.requestedPatches,manifest.requestedPatches);assert.equal(report.requests.attempts,manifest.httpAttempts);
  assert.equal(report.autoRegistryEligible,false);assert.equal(report.deployable,false);assert.equal(report.databaseWrites,0);
  for(const p of report.comparisons){assert.equal(p.knownAt,null);assert.equal(p.verifiedReleasedAt,null);assert.equal(p.coverageUntil,null);assert.equal(p.autoRegistryEligible,false);
    for(const h of p.heroNotes){assert.equal(h.impactLevel,null);assert.equal(h.availability,null);}
  }
  for(const s of report.sourceEvidence){assert.ok(['www.dota2.com','api.steampowered.com'].includes(new URL(s.url).hostname));assert.equal(s.knownAt,null);assert.match(s.payloadSha256,/^[a-f0-9]{64}$/);}
  assert.ok(!reportBody.includes(Buffer.from('"note":')));assert.ok(!reportBody.includes(Buffer.from('"contents":')));
});
test('audited maps stay deduplicated with unknown verified patches and no scored or trained samples',()=>{
  assert.equal(new Set(report.mapCoverage.maps.map(m=>m.matchId)).size,report.mapCoverage.uniqueMaps);
  assert.equal(report.mapCoverage.uniqueMaps,manifest.uniqueMaps);assert.equal(report.mapCoverage.verifiedPatchMaps,0);
  for(const m of report.mapCoverage.maps){assert.equal(m.verifiedPatchId,null);assert.equal(m.historicalKnownAt,null);}
  assert.equal(report.empiricalEvaluation.status,'unavailable');assert.equal(report.empiricalEvaluation.scoredMaps,0);
  assert.equal(report.empiricalEvaluation.brier,null);assert.equal(report.empiricalEvaluation.logLoss,null);assert.equal(report.empiricalEvaluation.ece,null);
});
const archiveManifest=JSON.parse(await readFile(new URL('../../docs/evidence/s1-07-archived-announcement.manifest.json',import.meta.url),'utf8'));
const archiveBytes=await readFile(new URL('../../'+archiveManifest.file,import.meta.url)),archived=JSON.parse(archiveBytes);
test('actual archived announcement is byte-bound to its manifest and CDX/Memento identity',()=>{
  assert.equal(createHash('sha256').update(archiveBytes).digest('hex'),archiveManifest.sha256);
  assert.equal(archived.captureStatus,'complete');assert.deepEqual(archived.errors,[]);assert.equal(archived.proof.scope,'announcement_body_only');
  assert.equal(archived.proof.cdxDigest,archived.indexRecords[0].digest);assert.equal(archived.proof.capturedAt,archived.indexRecords[0].capturedAt);
  assert.equal(archived.proof.currentBodyKnownByAt,archiveManifest.bodyKnownByAt);assert.equal(archived.proof.sameBodyAsCurrent,true);
  assert.equal(archived.proof.archived.bodySha256,archived.proof.current.bodySha256);
  assert.equal(archived.proof.payloadSha256,archived.sources.at(-1).payloadSha256);
  assert.ok(!archiveBytes.includes(Buffer.from('"body":')));assert.ok(!archiveBytes.includes(Buffer.from('server_password')));
});
test('five archived text observations never become five verified patch or training examples',()=>{
  assert.equal(archived.coverage.sourceBodyVerifiedMaps,5);assert.equal(archived.coverage.uniqueMaps,5);
  for(const m of archived.coverage.maps){assert.ok(m.announcementBodyKnownByAt<m.startedAt);assert.equal(m.verifiedPatchId,null);assert.equal(m.trainingEligible,false);}
  assert.equal(archived.proof.verifiedReleasedAt,null);assert.equal(archived.proof.heroNotesKnownAt,null);assert.equal(archived.proof.archived.buildId,null);
  assert.equal(archived.verifiedPatchMaps,0);assert.equal(archived.trainingExamples,0);assert.equal(archived.autoRegistryEligible,false);assert.equal(archived.deployable,false);
});
