import test from 'node:test';
import assert from 'node:assert/strict';
import {createProspectiveCapture as capture,captureDigest,assessCaptureTiming} from '../../.tools/s304-prospective-capture-runtime/player-hero-prospective-capture.mjs';
import {createPlayerHeroFeatureBuilder} from '../../.tools/s304-prospective-capture-runtime/player-hero-feature.mjs';
import {fixture,rebind,T,day} from '../fixtures/player-hero-prospective-input.mjs';

test('valid synthetic capture preserves frozen numerical recipe and cannot claim live eligibility',()=>{
  const f=fixture();f.history.maps[0].players[0].heroId=20;rebind(f);const r=capture(f);
  assert.equal(r.status,'validated_offline_contract');assert.equal(r.syntheticOnly,true);
  assert.equal(r.observedHeroPracticeLog90Delta,createPlayerHeroFeatureBuilder(f.history)(f.scenario).feature);
  assert(Math.abs(r.observedHeroPracticeLog90Delta-(Math.log(5)-Math.log(6))/5)<1e-14);
  assert.deepEqual(r.historyCoverage.map(p=>p.priorProMaps),Array(10).fill(5));
  assert.equal(r.historyLedger.length,5);assert.equal(r.readiness.primaryEligible,false);
  assert.equal(r.scoringPerformed,false);assert.equal(r.releaseGatePassed,false);assert.equal(r.deployable,false);
});

test('old builder admits late receipt but adapter excludes it with full ledger and no count leakage',()=>{
  const f=fixture(),extra=structuredClone(f.history.maps[0]);extra.matchId='999';extra.fetchedAtUs=String(T);
  f.history.maps.push(extra);f.historyObservations.push({...f.historyObservations[0],matchId:'999',observedAtUs:String(T),recordedAtUs:String(T+1n)});rebind(f);
  assert.equal(createPlayerHeroFeatureBuilder(f.history)(f.scenario).teamA[0].nRaw,6);
  const r=capture(f);assert.equal(r.status,'validated_offline_contract');assert.equal(r.practiceDiagnostic.teamA[0].nRaw,5);
  assert.equal(r.historyLedger.length,6);assert(r.historyLedger.find(x=>x.matchId==='999').reasons.includes('HISTORY_FETCH_NOT_BEFORE_CUTOFF'));
});

test('local verification can establish future availability without backdating provider known_at',()=>{
  const f=fixture();f.history.maps[0].knownAtUs=null;f.historyObservations[0].basis='local_receipt_verification';rebind(f);
  const before=structuredClone(f),r=capture(f);assert.deepEqual(f,before);assert.equal(r.status,'validated_offline_contract');
  assert.equal(r.availableHistory.maps.find(m=>m.matchId===f.history.maps[0].matchId).knownAtUs,null);
  assert.equal(r.historyLedger.find(m=>m.matchId===f.history.maps[0].matchId).originalKnownAtUs,null);
  assert(r.practiceDiagnostic.warnings.includes('HISTORY_AVAILABILITY_NOT_ESTABLISHED'));
  f.historyObservations[0].observedAtUs=String(T);f.historyObservations[0].recordedAtUs=String(T+1n);
  const late=capture(f);assert.equal(late.status,'unavailable');assert.equal(late.availableHistory.maps.length,4);
});

for(const [label,change] of [
  ['fetch equality',f=>{f.history.maps[0].fetchedAtUs=String(T);f.historyObservations[0].observedAtUs=String(T);f.historyObservations[0].recordedAtUs=String(T+1n);}],
  ['known equality',f=>{f.history.maps[0].knownAtUs=String(T);f.historyObservations[0].observedAtUs=String(T);f.historyObservations[0].recordedAtUs=String(T+1n);}],
  ['completion equality',f=>{f.history.maps[0].completedAtUs=String(T);f.history.maps[0].fetchedAtUs=String(T+1n);f.historyObservations[0].observedAtUs=String(T+2n);f.historyObservations[0].recordedAtUs=String(T+3n);}],
  ['record equality',f=>f.historyObservations[0].recordedAtUs=String(T)],
  ['missing observation',f=>f.historyObservations.shift()],
  ['null provider known',f=>f.history.maps[0].knownAtUs=null],
  ['observation before receipt',f=>f.historyObservations[0].observedAtUs=f.history.maps[0].completedAtUs],
  ['target map',f=>{f.scenario.targetMatchId=f.history.maps[0].matchId;}],
  ['cross-account merge',f=>f.history.maps[0].players[0].accountId='999'],
])test(`rejects history from model input: ${label}`,()=>{
  const f=fixture();change(f);rebind(f);const r=capture(f);
  assert.equal(r.availableHistory.maps.length,4);assert.equal(r.historyLedger.filter(r=>!r.included).length,1);
  assert.equal(r.status,'unavailable');assert.equal(r.observedHeroPracticeLog90Delta,null);
  assert(r.reasons.includes('ELO_HISTORY_BELOW_FIVE_PRO_MAPS'));
});

test('history before 90d still meets general pro minimum; zero hero volume adds no gate',()=>{
  const f=fixture();for(const m of f.history.maps){m.startedAtUs=String(T-100n*day);m.completedAtUs=String(T-99n*day);m.fetchedAtUs=String(T-98n*day);m.knownAtUs=m.completedAtUs;}
  for(const o of f.historyObservations){o.fetchedAtUs=String(T-98n*day);o.observedAtUs=String(T-97n*day);o.recordedAtUs=String(T-96n*day);}rebind(f);
  const r=capture(f);assert.equal(r.status,'validated_offline_contract');assert.equal(r.observedHeroPracticeLog90Delta,0);
  assert(r.historyCoverage.every(p=>p.priorProMaps===5));assert(r.practiceDiagnostic.teamA.every(p=>p.nRaw===0));
});

test('unknown hero differs from zero; truncated history remains unavailable',()=>{
  const f=fixture();f.history.maps[0].players[0].heroId=null;rebind(f);let r=capture(f);
  assert.equal(r.practiceDiagnostic.teamA[0].nRaw,4);assert.equal(r.practiceDiagnostic.teamA[0].heroUnknownMaps,1);
  f.history.fromAtUs=String(T-10n*day);r=capture(f);assert.equal(r.observedHeroPracticeLog90Delta,null);
  assert(r.reasons.includes('HISTORY_WINDOW_START_TRUNCATED'));
  f.history.fromAtUs=String(T-200n*day);f.history.toAtUs=String(T-1n);r=capture(f);
  assert(r.reasons.includes('HISTORY_WINDOW_END_TRUNCATED'));
});

test('late or missing lineup/draft/identity evidence never becomes a valid capture',()=>{
  for(const change of [f=>f.lineupObservation=null,f=>f.draftObservation=null,f=>f.identityObservations.pop(),
    f=>f.draftObservation.recordedAtUs=String(T),f=>f.lineupObservation.observedAtUs=String(T),
    f=>f.identityObservations[0].recordedAtUs=String(T),f=>f.scenario.selectedAtUs=String(T),
    f=>f.draftObservation.fetchedAtUs=String(T),f=>f.identityObservations[0].sourceKnownAtUs=String(T),
    f=>f.scenario.targetMatchId=null]){
    const f=fixture();change(f);rebind(f);const r=capture(f);assert.equal(r.status,'unavailable');assert.equal(r.observedHeroPracticeLog90Delta,null);
  }
});

test('bindings reject A/B, hero, identity, receipt and revision substitution',()=>{
  for(const change of [f=>{[f.scenario.teamA,f.scenario.teamB]=[f.scenario.teamB,f.scenario.teamA];},
    f=>{[f.scenario.teamA[0].heroId,f.scenario.teamA[1].heroId]=[f.scenario.teamA[1].heroId,f.scenario.teamA[0].heroId];},
    f=>f.scenarioRevision='2',f=>f.identityObservations[0].factSha256='b'.repeat(64),
    f=>f.history.maps[0].players[0].heroId=20,f=>f.historyObservations[0].sourceSha256='b'.repeat(64)]){
    const f=fixture();change(f);assert.throws(()=>capture(f));
  }
});

test('fresh swapped binding negates scalar; input order cannot define a side',()=>{
  const f=fixture();f.history.maps[0].players[0].heroId=20;rebind(f);const first=capture(f);
  [f.scenario.teamA,f.scenario.teamB]=[f.scenario.teamB,f.scenario.teamA];rebind(f);
  assert.equal(capture(f).observedHeroPracticeLog90Delta,-first.observedHeroPracticeLog90Delta);
  f.history.maps.reverse();f.historyObservations.reverse();f.scenario.teamA.reverse();f.scenario.teamB.reverse();
  assert.equal(capture(f).observedHeroPracticeLog90Delta,-first.observedHeroPracticeLog90Delta);
});

test('strict input rejects labels, probabilities, telemetry, non-pro data and invalid identities',()=>{
  const changes=[f=>f.label=true,f=>f.scenario.probability=.8,f=>f.history.maps[0].radiantWin=true,
    f=>f.history.maps[0].isPro=false,f=>f.history.maps[0].players[0].kills=5,
    f=>f.scenario.teamB[0].heroId=f.scenario.teamA[0].heroId,
    f=>f.scenario.teamB[0].accountId=f.scenario.teamA[0].accountId,
    f=>f.scenario.teamB[0].playerId=f.scenario.teamA[0].playerId,
    f=>f.history.maps.push(f.history.maps[0]),f=>f.historyObservations.push(f.historyObservations[0]),
    f=>f.identityObservations[0].basis='owner_asserted_asof',f=>f.identityObservations[0].accountId='999',
    f=>f.historyObservations[0].matchId='999',f=>f.syntheticOnly=false,
    f=>f.snapshotFrozenAtUs=String(T-1n),f=>f.history.snapshotAtUs=String(T+4000000n),
    f=>f.scenario.cutoffAtUs=String(T+1n),f=>f.scenario.targetMatchId=9007199254740993,
    f=>f.scenario.heroBasis='reconstructed_final_receipt'];
  for(const change of changes){const f=fixture();change(f);assert.throws(()=>capture(f));}
});

test('captures are deeply immutable and replay without mutating caller facts',()=>{
  const f=fixture(),before=structuredClone(f),r=capture(f);assert.deepEqual(f,before);
  assert.deepEqual(capture(f),r);assert.throws(()=>r.availableHistory.maps.pop());
  assert.throws(()=>r.input.scenario.teamA[0].heroId=99);f.history.maps=[];
  assert.equal(r.availableHistory.maps.length,5);assert.equal(captureDigest({b:1,a:2}),captureDigest({a:2,b:1}));
  assert.throws(()=>captureDigest({a:undefined}));
});

test('empty history preserves unavailable/null rather than inventing a usable input',()=>{
  const f=fixture();f.history.maps=[];f.historyObservations=[];const r=capture(f);
  assert.equal(r.status,'unavailable');assert.equal(r.observedHeroPracticeLog90Delta,null);
  assert.equal(r.historyLedger.length,0);assert(r.historyCoverage.every(p=>p.priorProMaps===0));
});

test('ninety-day boundary is inclusive and observation chronology is strict',()=>{
  const f=fixture(),m=f.history.maps[0],o=f.historyObservations[0];
  m.startedAtUs=String(T-90n*day);m.completedAtUs=String(T-89n*day);m.fetchedAtUs=String(T-88n*day);m.knownAtUs=m.completedAtUs;
  o.fetchedAtUs=m.fetchedAtUs;o.observedAtUs=String(T-87n*day);o.recordedAtUs=String(T-86n*day);rebind(f);
  assert.equal(capture(f).practiceDiagnostic.teamA[0].nRaw,5);
  m.startedAtUs=String(T-90n*day-1n);rebind(f);assert.equal(capture(f).practiceDiagnostic.teamA[0].nRaw,4);
  o.recordedAtUs=String(T-88n*day);assert.equal(capture(f).status,'unavailable');
});

function timing(r){return {captureFingerprint:r.fingerprint,targetMatchId:r.input.scenario.targetMatchId,
  capturePersistedAtUs:String(T+4000000n),capturePersistenceReceiptSha256:'b'.repeat(64),
  actualGameplayStartedAtUs:String(T+60000000n),startObservedAtUs:String(T+61000000n),startRecordedAtUs:String(T+62000000n),
  actualStartSourceSha256:'c'.repeat(64),clockSemanticsEvidenceSha256:'d'.repeat(64)};}
test('actual-start assessment is separate and cannot certify a prediction or mutate capture',()=>{
  const r=capture(fixture()),before=captureDigest(r),e=timing(r),result=assessCaptureTiming(r,e);
  assert.equal(result.status,'passes_declared_clock_contract');assert.equal(result.primaryEligible,false);
  assert.equal(captureDigest(r),before);
  e.actualGameplayStartedAtUs=e.capturePersistedAtUs;assert.equal(assessCaptureTiming(r,e).status,'unavailable');
  e.actualGameplayStartedAtUs=String(T-1n);assert.equal(assessCaptureTiming(r,e).status,'unavailable');
});
test('timing rejects forged target/fingerprint, scheduled-only clock and rewritten capture',()=>{
  const r=capture(fixture());
  for(const change of [e=>e.targetMatchId='1',e=>e.captureFingerprint='e'.repeat(64),e=>delete e.clockSemanticsEvidenceSha256,
    e=>{e.scheduledAtUs=e.actualGameplayStartedAtUs;delete e.actualGameplayStartedAtUs;}]){
    const e=timing(r);change(e);assert.throws(()=>assessCaptureTiming(r,e));
  }
  const forged=structuredClone(r);forged.reasons=['forged'];assert.throws(()=>assessCaptureTiming(forged,timing(r)));
  const e=timing(r);e.capturePersistedAtUs=String(T);assert(assessCaptureTiming(r,e).reasons.includes('PERSISTENCE_BEFORE_SNAPSHOT'));
});
