import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildProspectivePlayerHeroFeatures as build} from '../../.tools/s304-prospective-features-runtime/player-hero-prospective-features.mjs';
import {infer} from '../../.tools/s304-prospective-features-runtime/player-hero-inference.mjs';
import {createV1FeatureBuilder} from '../../packages/prediction/dist/index.js';
import {captureDigest,createProspectiveCapture} from '../../.tools/s304-prospective-capture-runtime/player-hero-prospective-capture.mjs';
import {featureFixture,bindFeatureEvidence} from '../fixtures/player-hero-prospective-features.mjs';
import {rebind,T} from '../fixtures/player-hero-prospective-input.mjs';
const close=(a,b)=>assert(Math.abs(a-b)<1e-12,`${a} != ${b}`);

test('adapter reuses frozen Elo and hero recipe; inputs only, immutable and not deployable',()=>{
  const f=featureFixture(),original=structuredClone(f),r=build(f);
  assert.equal(r.status,'ready_offline_features');assert.equal(r.teamAWinProbability,null);
  const old=createV1FeatureBuilder(f.history)(r.eloSnapshot.scenario);
  assert.deepEqual(old,r.eloSnapshot);close(r.inputs.eloLogit,Math.log(10)*old.features.eloDifference/400);
  close(r.inputs.observedHeroPracticeLog90Delta,(Math.log(5)-Math.log(6))/5);
  assert.deepEqual(r.encoded.H1,[r.inputs.eloLogit]);assert.equal(r.encoded.H2.length,2);
  for(const k of ['primaryEligible','registrationAllowed','collectionAllowed','trainingPerformed','scoringPerformed','deployable'])assert.equal(r[k],false);
  assert.throws(()=>{r.encoded.H2[0]=0;},TypeError);assert.deepEqual(f,original);
});

test('target A/B swap negates both features; display ordering cannot change values',()=>{
  const f=featureFixture(),a=build(f),raw=structuredClone(f.capture.input);
  [raw.scenario.teamA,raw.scenario.teamB]=[raw.scenario.teamB,raw.scenario.teamA];
  f.capture=createProspectiveCapture(rebind(raw));const b=build(f);
  close(a.inputs.eloLogit,-b.inputs.eloLogit);close(a.inputs.observedHeroPracticeLog90Delta,-b.inputs.observedHeroPracticeLog90Delta);
  f.history.maps.reverse();for(const m of f.history.maps){m.teamA.reverse();m.teamB.reverse();}
  bindFeatureEvidence(f);assert.deepEqual(build(f).inputs,b.inputs);
});

test('historical side swap with winner reversal preserves Elo; hero order never implies side',()=>{
  const f=featureFixture(),a=build(f);
  for(const m of f.history.maps){[m.teamA,m.teamB]=[m.teamB,m.teamA];m.teamAWon=!m.teamAWon;}
  close(build(bindFeatureEvidence(f)).inputs.eloLogit,a.inputs.eloLogit);
});

for(const [name,mutate] of [
  ['verification at cutoff',f=>{f.history.maps[0].labelVerifiedAtUs=String(T);f.outcomeObservations[0].observedAtUs=String(T);f.outcomeObservations[0].recordedAtUs=String(T);} ],
  ['observation at cutoff',f=>{f.outcomeObservations[0].observedAtUs=String(T);f.outcomeObservations[0].recordedAtUs=String(T);} ],
  ['source known at cutoff',f=>{f.outcomeObservations[0].sourceKnownAtUs=String(T);} ],
  ['receipt at cutoff',f=>{f.history.maps[0].fetchedAtUs=String(T);f.history.maps[0].labelVerifiedAtUs=String(T);} ],
  ['missing outcome evidence',f=>{f.outcomeObservations.shift();}],
  ['invalid observation order',f=>{f.outcomeObservations[0].recordedAtUs='0';}],
])test(name+' excludes historical outcome, returns null without fallback',()=>{
  const f=featureFixture();mutate(f);const r=build(bindFeatureEvidence(f));
  assert.equal(r.status,'unavailable');assert.equal(r.inputs,null);assert.equal(r.encoded,null);
  assert(!r.mapLedger.find(m=>m.matchId===f.history.maps[0].matchId).included);
});

test('known series sibling is excluded when one result is late',()=>{
  const f=featureFixture();f.history.maps[1].seriesKey=f.history.maps[0].seriesKey;
  f.outcomeObservations[0].recordedAtUs=String(T);const r=build(bindFeatureEvidence(f));
  assert.equal(r.mapLedger.filter(m=>!m.included).length,2);assert.equal(r.eloSnapshot.coverage.nRaw,3);
});

test('missing map sidecar is explicit incomplete inventory, never a smaller silent sample',()=>{
  const f=featureFixture();f.history.maps.shift();f.outcomeObservations.shift();
  assert(build(f).reasons.includes('OUTCOME_HISTORY_INCOMPLETE'));
});

test('late identity cannot supply rating; verified same-account conflict remains visible',()=>{
  const f=featureFixture();f.identityObservations[0].recordedAtUs=String(T);
  assert(build(f).reasons.includes('IDENTITY_UNVERIFIED'));
  const g=featureFixture(),i={...g.history.identities[0],observationId:'conflict',playerId:'999'};
  g.history.identities.push(i);g.identityObservations.push({...g.identityObservations[0],observationId:'conflict'});
  assert(build(bindFeatureEvidence(g)).reasons.includes('IDENTITY_CONFLICT'));
});

test('zero hero history remains valid when general professional history exists',()=>{
  const f=featureFixture(),raw=structuredClone(f.capture.input);
  for(const m of raw.history.maps)for(const p of m.players)p.heroId=100+p.heroId;
  f.capture=createProspectiveCapture(rebind(raw));const r=build(f);
  assert.equal(r.status,'ready_offline_features');assert.equal(r.inputs.observedHeroPracticeLog90Delta,0);
});

test('capture flags cannot be rewritten even with a new fingerprint',()=>{
  const f=featureFixture();f.capture=structuredClone(f.capture);f.capture.readiness.primaryEligible=true;
  const {fingerprint,...body}=f.capture;f.capture.fingerprint=captureDigest(body);
  assert.throws(()=>build(f),/capture_replay_mismatch/);
});

for(const [name,mutate,code] of [
  ['target label',f=>{f.history.maps[0].matchId=f.capture.input.scenario.targetMatchId;f.outcomeObservations[0].matchId=f.history.maps[0].matchId;},/target_outcome_forbidden/],
  ['foreign map',f=>{f.history.maps[0].matchId='777';f.outcomeObservations[0].matchId='777';},/foreign_outcome_map/],
  ['wrong account',f=>{f.history.maps[0].teamA[0].accountId='777';},/history_map_binding_mismatch/],
  ['duplicate observation',f=>{f.outcomeObservations.push(f.outcomeObservations[0]);},/duplicate_outcome_observation/],
  ['wrong synthetic flag',f=>{f.history.syntheticOnly=false;},/synthetic_provenance_mismatch/],
  ['changed history window',f=>{f.history.warmupFromAtUs='0';},/history_window_mismatch/],
])test(name+' fails closed',()=>{const f=featureFixture();mutate(f);assert.throws(()=>build(bindFeatureEvidence(f)),code);});

test('changed outcome without rebinding cannot be consumed',()=>{
  const f=featureFixture();f.history.maps[0].teamAWon=!f.history.maps[0].teamAWon;
  assert.throws(()=>build(f),/outcome_evidence_binding_mismatch/);
});

test('one microsecond before cutoff is allowed; fact clocks at cutoff are excluded',()=>{
  const f=featureFixture();f.outcomeObservations[0].recordedAtUs=String(T-1n);
  assert.equal(build(f).status,'ready_offline_features');
  f.history.maps[0].factClocks=[{id:'1',field:'outcome',eventAtUs:null,knownAtUs:String(T),
    fetchedAtUs:String(T),recordedAtUs:String(T),reviewState:'verified',availability:'known'}];
  const r=build(bindFeatureEvidence(f));
  assert.equal(r.inputs,null);assert(r.mapLedger.some(m=>m.reasons.includes('HISTORY_FACT_NOT_BEFORE_CUTOFF')));
});

test('empty history and duplicate map IDs cannot produce a forecast',()=>{
  const f=featureFixture();f.history.maps=[];f.outcomeObservations=[];
  const r=build(f);assert.equal(r.inputs,null);assert.equal(r.eloSnapshot.coverage.nRaw,0);
  assert(r.eloSnapshot.teamA.every(p=>p.rating===null));
  const g=featureFixture();g.history.maps.push(g.history.maps[0]);assert.throws(()=>build(g),/duplicate_outcome_map/);
});

test('a rejected capture cannot be rescued by an otherwise valid Elo history',()=>{
  const f=featureFixture(),raw=structuredClone(f.capture.input);raw.draftObservation=null;
  f.capture=createProspectiveCapture(raw);const r=build(f);
  assert.equal(r.inputs,null);assert(r.reasons.includes('CAPTURE_UNAVAILABLE'));
  assert.equal(r.eloSnapshot.status,'ready');
});

test('fixed H1/H2 inference matches previously frozen Python goldens, no refit',()=>{
  const bytes=readFileSync(new URL('../../.tools/s304-hero-fit-r1/artifact.json',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b');
  const artifact=JSON.parse(bytes);
  for(const g of artifact.goldens)for(const name of ['H1','H2']){
    const model=structuredClone(artifact.models[name]);
    if(g.case==='calibrator_unavailable')model.calibration={status:'insufficient',temperature:null};
    const result=infer(model,name,g.inputs);
    close(result.rawProbability,g.expected[name].rawProbability);
    if(g.expected[name].calibratedProbability===null)assert.equal(result.calibratedProbability,null);
    else close(result.calibratedProbability,g.expected[name].calibratedProbability);
  }
});
