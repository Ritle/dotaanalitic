/** Private offline scoring only. This module is never imported by the API or UI. */
import assert from 'node:assert/strict';
import {sha} from './draft-native-export-core.mjs';
import {auditShadowFeatures} from './draft-shadow-features-core.mjs';
import {infer,sigmoid} from '../../.tools/s304-shadow-runtime/player-hero-inference.mjs';

export const CANDIDATE_SHA='9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b';
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export function shadowCandidate(text,syntheticSource){
  assert(typeof text==='string'&&Buffer.byteLength(text)<=4*1024*1024,'candidate_size');
  const a=JSON.parse(text),hash=sha(text);
  assert.equal(a.format,'player-hero-research-fit-v1');assert.equal(a.deployable,false);
  assert(typeof a.syntheticOnly==='boolean','candidate_synthetic_flag');
  if(a.syntheticOnly)assert.equal(syntheticSource,true,'synthetic_candidate_on_real_source');
  else assert.equal(hash,CANDIDATE_SHA,'frozen_candidate_sha_mismatch');
  const inputs={eloLogit:0,observedHeroPracticeLog90Delta:0};
  for(const name of ['H1','H2']){
    assert.equal(a.models[name].calibration.status,'fitted','calibrator_unavailable');
    assert.notEqual(infer(a.models[name],name,inputs).calibratedProbability,null);
  }
  return {sha256:hash,syntheticOnly:a.syntheticOnly,models:a.models};
}

export function calculateShadow(source,candidateText,calculatedAt){
  assert(typeof calculatedAt==='string'&&new Date(calculatedAt).toISOString()===calculatedAt,'calculation_clock');
  // Export clocks have microsecond precision; do not round a future export down.
  const micros=s=>BigInt(Date.parse(s))*1000n+BigInt((s.match(/\.(\d{6})Z$/)?.[1]??'000000').slice(3));
  assert(micros(source.native.exportedAt)<=micros(calculatedAt),'calculation_before_export');
  const candidate=shadowCandidate(candidateText,source.native.syntheticOnly),features=auditShadowFeatures(source);
  const captures=new Map(source.native.captures.map(c=>[c.id,c]));
  const observations=new Map(source.observations.map(o=>[o.id,o]));
  const items=features.items.map(item=>{
    const inputs=item.features.inputs,c=captures.get(item.captureId),o=observations.get(item.observationId);
    const frozenInput={captureId:c.id,captureSha256:c.snapshotSha256,observationId:o?.id??null,
      observationSha256:o?.evidenceSha256??null,featurePolicy:features.featurePolicy,
      candidateSha256:candidate.sha256,features:item.features};
    const scores=inputs?{H0:{rawProbability:sigmoid(inputs.eloLogit),calibratedProbability:sigmoid(inputs.eloLogit)},
      H1:infer(candidate.models.H1,'H1',inputs),H2:infer(candidate.models.H2,'H2',inputs)}:null;
    return {...item,inputFingerprint:sha(JSON.stringify(frozenInput)),
      shadowStatus:scores?'computed_shadow_only':'unavailable',researchScores:scores,
      calculationReasons:inputs?[]:item.features.reasons,
      limitations:['NOT_A_PUBLISHED_FORECAST','INDEPENDENT_QUALITY_GATE_NOT_PASSED',
        'MANUAL_LINEUP_CONDITIONAL','LATE_BINDING_MUST_NOT_REPLACE_FROZEN_RESULT',
        'FILE_WRITE_COMPLETION_AND_PRESTART_AVAILABILITY_NOT_ATTESTED']};
  });
  const body={format:'draft-shadow-result-v1',calculatedAt,candidateSha256:candidate.sha256,
    featurePolicy:features.featurePolicy,featureAudit:features,items,
    counts:{...features.counts,scoredCaptures:items.filter(i=>i.researchScores!==null).length},
    syntheticOnly:source.native.syntheticOnly,scoringPerformed:items.some(i=>i.researchScores!==null),
    trainingPerformed:false,collectionAllowed:false,primaryEligible:false,deployable:false,
    forecastStatus:'unavailable',teamAWinProbability:null};
  return freeze({...body,fingerprint:sha(JSON.stringify(body))});
}
