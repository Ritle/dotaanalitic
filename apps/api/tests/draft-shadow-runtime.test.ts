import {test,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileNativeExportRuntime} from '../../../tests/helpers/native-export-runtime.js';
import {shadowFeatureFixture} from '../../../tests/helpers/draft-shadow.js';
import {editObservation} from '../../../tests/helpers/draft-observation-features.js';
import {DraftCaptureSavedSchema} from '../src/modules/scenarios/draft-capture-contract.js';
import {DraftHistorySavedSchema} from '../src/modules/scenarios/draft-history-contract.js';
import {buildShadowFeatures} from '../src/modules/scenarios/draft-shadow-features.js';
import {calculateDraftShadow,parseShadowCandidate} from '../src/modules/scenarios/draft-shadow-runtime.js';
compileNativeExportRuntime();
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','tools/research/player-hero-shadow-feature.mts','tools/research/player-hero-inference.mts',
  '--strict','--noUncheckedIndexedAccess','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--types','node',
  '--typeRoots','packages/db/node_modules/@types','--outDir','.tools/s304-shadow-runtime'],
  {cwd:fileURLToPath(new URL('../../../',import.meta.url)),windowsHide:true,stdio:'pipe',timeout:120000});
const {auditShadowFeatures}=await import('../../../tools/audits/draft-shadow-features-core.mjs');
const {calculateShadow}=await import('../../../tools/audits/draft-shadow-core.mjs');
const candidateText=JSON.stringify({format:'player-hero-research-fit-v1',syntheticOnly:true,deployable:false,models:{
  H1:{status:'fitted',intercept:0,coefficients:[.8],featureOrder:['eloLogit'],calibration:{status:'fitted',temperature:.9}},
  H2:{status:'fitted',intercept:0,coefficients:[.75,.13],featureOrder:['eloLogit','observedHeroPracticeLog90Delta'],calibration:{status:'fitted',temperature:.85}}}});
function saved(f:ReturnType<typeof shadowFeatureFixture>){const c=f.native.captures[0]!,o=f.observations[0]!;return {
  capture:DraftCaptureSavedSchema.parse({id:c.id,sha256:c.snapshotSha256,recordedAt:c.recordedAt,snapshot:JSON.parse(c.snapshotText)}),
  history:DraftHistorySavedSchema.parse({id:o.id,sha256:o.evidenceSha256,recordedAt:o.recordedAt,evidence:JSON.parse(o.evidenceText)})};}
test('runtime inputs, coverage and ledgers match the frozen offline adapter exactly',()=>{
  const f=shadowFeatureFixture(),s=saved(f),old=auditShadowFeatures(f).items[0].features;
  expect(buildShadowFeatures(s.capture,s.history,true)).toEqual(old);
  const r=calculateDraftShadow(s.capture,s.history,parseShadowCandidate(candidateText,true),'2026-01-03T00:00:01.000000Z','a'.repeat(64));
  expect(r.researchScores).toEqual(calculateShadow(f,candidateText,'2026-01-03T00:00:01.000Z').items[0].researchScores);
  expect(r.status).toBe('computed_shadow_only');expect(r.syntheticOnly).toBe(true);expect(r.teamAWinProbability).toBeNull();
});
test('clock, identity, missing heroes and incomplete series have identical exclusions',()=>{
  for(const variant of ['identity','outcome','hero','order']){
    const f=shadowFeatureFixture();editObservation(f,e=>{
      if(variant==='identity')e.history.identities[0]!.fetchedAt=e.readAt.slice(0,23)+'Z';
      if(variant==='outcome')e.outcomes[0]={status:'unavailable',matchId:e.history.maps[0]!.id,reasons:['MISSING_LABEL']};
      if(variant==='hero')for(const p of e.history.players)p.hero_id=null;
      if(variant==='order'){e.history.maps.reverse();e.history.players.reverse();}
    });const s=saved(f);expect(buildShadowFeatures(s.capture,s.history,true)).toEqual(auditShadowFeatures(f).items[0].features);
  }
});
test('missing model and legacy history persist explicit unavailable without invented probabilities',()=>{
  const s=saved(shadowFeatureFixture());
  const r=calculateDraftShadow(s.capture,s.history,null,'2026-01-03T00:00:01.000000Z','a'.repeat(64));
  expect(r.status).toBe('unavailable');expect(r.reasons).toContain('SHADOW_CANDIDATE_UNAVAILABLE');expect(r.researchScores).toBeNull();
  expect(calculateDraftShadow(s.capture,null,null,'2026-01-03T00:00:01.000000Z','a'.repeat(64)).reasons).toContain('PRE_CUTOFF_HISTORY_OBSERVATION_MISSING');
});
test('synthetic candidate cannot enter default loader boundary; tampered real SHA fails closed',()=>{
  expect(()=>parseShadowCandidate(candidateText)).toThrow('shadow_candidate_sha');
  expect(()=>parseShadowCandidate(candidateText.replace('"syntheticOnly":true','"syntheticOnly":false'))).toThrow('shadow_candidate_sha');
});
test('foreign observations, exact cutoff persistence and backdated calculations are rejected',()=>{
  for(const variant of ['scenario','clock','late']){
    const s=saved(shadowFeatureFixture());
    if(variant==='scenario')s.history.evidence.selection.revision++;
    if(variant==='clock')s.history.recordedAt=s.capture.snapshot.decisionCutoffAt;
    expect(()=>calculateDraftShadow(s.capture,s.history,null,variant==='late'?'2025-01-01T00:00:00.000000Z':'2026-01-03T00:00:01.000000Z','a'.repeat(64))).toThrow();
  }
});
