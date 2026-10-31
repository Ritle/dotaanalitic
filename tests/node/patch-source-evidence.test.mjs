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
