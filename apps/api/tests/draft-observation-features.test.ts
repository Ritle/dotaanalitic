import {test,expect} from 'vitest';
import {compileNativeExportRuntime} from '../../../tests/helpers/native-export-runtime.js';
import {observationFeatureFixture,editObservation} from '../../../tests/helpers/draft-observation-features.js';
import {refreshNativeExport} from '../../../tests/helpers/draft-native-export.js';
import {registrySha,registryHash} from '@dota/db';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
compileNativeExportRuntime();
const {auditObservationFeatures}=await import('../../../tools/audits/draft-observation-features-core.mjs');
const {writeObservationFeatures,verifyObservationFeatures}=await import('../../../tools/audits/draft-observation-features.mjs');
test('SQL060 selection and verified history produce features without a forecast',()=>{
  const f=observationFeatureFixture(),before=structuredClone(f),r=auditObservationFeatures(f),item=r.items[0];
  expect(item.features.status).toBe('ready_offline_features');expect(item.features.inputs.eloLogit).toBeGreaterThan(0);
  expect(item.features.inputs.observedHeroPracticeLog90Delta).toBeCloseTo(-Math.log1p(6)/5,12);
  expect(item.features.coverage.nRaw).toBe(6);expect(item.features.encoded.H2).toHaveLength(2);
  expect(r.teamAWinProbability).toBeNull();expect(r.primaryEligible).toBe(false);expect(r.counts.trainingExamples).toBe(0);
  expect(f).toEqual(before);expect(Object.isFrozen(r)).toBe(true);
});

test('pending native target and legacy or orphan observations remain explicitly unavailable',()=>{
  const f=observationFeatureFixture();f.native.bindings=[];
  let r=auditObservationFeatures(f);expect(r.items[0].features.reasons).toContain('NATIVE_TARGET_UNRESOLVED');
  expect(r.items[0].features.eloSnapshot.scenario.targetMatchId).toBeNull();expect(r.items[0].features.inputs).toBeNull();
  f.links=[];r=auditObservationFeatures(f);expect(r.unlinkedObservationIds).toEqual([f.observations[0]!.id]);
  expect(r.items[0].features.reasons).toEqual(['PRE_CUTOFF_HISTORY_OBSERVATION_MISSING']);
  f.observations=[];expect(auditObservationFeatures(f).counts.observations).toBe(0);
});

test('foreign owner, recomputed selection forgery, exact-cutoff persistence and duplicate links reject export',()=>{
  for(const mutate of [
    (f:ReturnType<typeof observationFeatureFixture>)=>{f.observations[0]!.ownerId=randomUUID();},
    (f:ReturnType<typeof observationFeatureFixture>)=>{editObservation(f,e=>{e.selection.scenarioHash='0'.repeat(64);});},
    (f:ReturnType<typeof observationFeatureFixture>)=>{f.observations[0]!.recordedAt=JSON.parse(f.native.captures[0]!.snapshotText).decisionCutoffAt;},
    (f:ReturnType<typeof observationFeatureFixture>)=>{f.links.push(f.links[0]!);}
  ]){const f=observationFeatureFixture();mutate(f);expect(()=>auditObservationFeatures(f)).toThrow();}
});

test('unverified outcome removes its known series from both feature histories',()=>{
  const f=observationFeatureFixture();editObservation(f,e=>{
    e.outcomes[0]={status:'unavailable',matchId:e.history.maps[0]!.id,reasons:['NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT']};
    e.history.maps[1]!.series_id=e.history.maps[0]!.series_id;
    const o=e.outcomes[1]!;if(o.status==='verified')o.seriesId=e.history.maps[0]!.series_id;
  });
  const r=auditObservationFeatures(f).items[0].features;
  expect(r.mapLedger.filter((m:{included:boolean})=>!m.included)).toHaveLength(2);
  expect(r.coverage.nRaw).toBe(4);expect(r.reasons).toContain('INSUFFICIENT_PLAYER_HISTORY');expect(r.inputs).toBeNull();
});

test('player array order is irrelevant; native slot/side mismatch excludes the map',()=>{
  const f=observationFeatureFixture(),baseline=auditObservationFeatures(f).items[0].features.inputs;
  editObservation(f,e=>{e.history.players.reverse();});expect(auditObservationFeatures(f).items[0].features.inputs).toEqual(baseline);
  editObservation(f,e=>{e.history.players.find(p=>p.match_id==='1001'&&p.player_slot===0)!.side='dire';});
  const r=auditObservationFeatures(f).items[0].features;expect(r.coverage.nRaw).toBe(5);
  expect(r.mapLedger.find((m:{matchId:string})=>m.matchId==='1001').reasons).toContain('INVALID_HISTORY_FIVES');
});

test('unknown historical heroes retain sample warnings and never become win probabilities',()=>{
  const f=observationFeatureFixture();editObservation(f,e=>{for(const p of e.history.players)p.hero_id=null;});
  const r=auditObservationFeatures(f).items[0];expect(r.features.inputs.observedHeroPracticeLog90Delta).toBe(0);
  expect(r.features.heroSnapshot.warnings).toContain('HERO_HISTORY_INCOMPLETE');
  expect(r.features.heroSnapshot.teamA[0]).toMatchObject({nRaw:0,heroUnknownMaps:6});expect(r.teamAWinProbability).toBeNull();
});

test('actual target is excluded before consuming its outcome, regardless of the saved target label',()=>{
  const f=observationFeatureFixture(),target=f.native.bindings[0]!.matchId;
  editObservation(f,e=>{const old=e.history.maps[0]!.id;e.history.maps[0]!.id=target;e.outcomes[0]!.matchId=target;
    for(const p of e.history.players)if(p.match_id===old)p.match_id=target;
    for(const r of e.history.receipts)if(r.canonical_match_id===old){r.canonical_match_id=target;r.provider_match_id=target;}});
  const before=auditObservationFeatures(f).items[0].features;
  expect(before.coverage.nRaw).toBe(5);expect(before.mapLedger.find((m:{matchId:string})=>m.matchId===target).reasons).toEqual(['TARGET_MAP_EXCLUDED']);
  editObservation(f,e=>{e.history.maps[0]!.radiant_win=false;const o=e.outcomes[0]!;if(o.status==='verified')o.teamAWon=false;});
  expect(auditObservationFeatures(f).items[0].features.inputs).toEqual(before.inputs);
});

test('identity conflict fails the owner selection instead of granting a fresh Elo prior',()=>{
  const f=observationFeatureFixture();editObservation(f,e=>{e.history.identities.push({...e.history.identities[0]!,observationId:'synthetic:rejection',status:'rejected'});});
  const r=auditObservationFeatures(f).items[0].features;expect(r.inputs).toBeNull();expect(r.coverage.nRaw).toBeNull();expect(r.reasons).toContain('SELECTION_IDENTITY_NOT_AS_OBSERVED');
});

test('capture persisted at provider start retains diagnostic inputs but never becomes a pre-start forecast',()=>{
  const f=observationFeatureFixture();f.native.captures[0]!.recordedAt='2026-01-01T12:00:00.000000Z';refreshNativeExport(f.native);
  const r=auditObservationFeatures(f).items[0];expect(r.features.status).toBe('ready_offline_features');
  expect(r.eligibilityReasons).toContain('CAPTURE_NOT_BEFORE_PROVIDER_START');expect(r.forecastStatus).toBe('unavailable');
  expect(r.primaryEligible).toBe(false);expect(r.teamAWinProbability).toBeNull();
});

test('identity fetched, known or effective at history read cannot enter frozen selection',()=>{
  for(const field of ['fetchedAt','knownAt','eventAt'] as const){
    const f=observationFeatureFixture();editObservation(f,e=>{
      e.history.identities[0]!.fetchedAt=e.readAt.slice(0,23)+'Z';
      e.history.identities[0]![field]=e.readAt.slice(0,23)+'Z';
    });
    const r=auditObservationFeatures(f).items[0].features;expect(r.inputs).toBeNull();
    expect(r.reasons).toContain('SELECTION_IDENTITY_NOT_AS_OBSERVED');expect(r.identityLedger[0].included).toBe(false);
  }
});

test('empty verified history does not grant a 50/50 prior',()=>{
  const f=observationFeatureFixture();editObservation(f,e=>{
    e.history.maps=[];e.history.players=[];e.history.receipts=[];e.history.series=[];e.outcomes=[];
  });
  const r=auditObservationFeatures(f).items[0];expect(r.features.coverage.nRaw).toBe(0);
  expect(r.features.inputs).toBeNull();expect(r.features.reasons).toContain('INSUFFICIENT_PLAYER_HISTORY');
  expect(r.teamAWinProbability).toBeNull();
});

test('swapping owner A/B reverses both inputs while historical Radiant/Dire stay unchanged',()=>{
  const f=observationFeatureFixture(),before=auditObservationFeatures(f).items[0].features.inputs,c=f.native.captures[0]!,s=JSON.parse(c.snapshotText);
  [s.scenario.teamAId,s.scenario.teamBId]=[s.scenario.teamBId,s.scenario.teamAId];
  [s.scenario.lineupA,s.scenario.lineupB]=[s.scenario.lineupB,s.scenario.lineupA];
  for(const p of s.players)p.teamSlot=p.teamSlot==='A'?'B':'A';
  for(const p of s.scenario.draft.assignments)p.teamSlot=p.teamSlot==='A'?'B':'A';
  s.scenarioHash=registrySha(JSON.stringify(s.scenario));c.snapshotText=JSON.stringify(s);refreshNativeExport(f.native);
  editObservation(f,e=>{e.selection.scenarioHash=s.scenarioHash;});
  const after=auditObservationFeatures(f).items[0].features.inputs;
  expect(after.eloLogit).toBeCloseTo(-before.eloLogit,12);expect(after.observedHeroPracticeLog90Delta).toBeCloseTo(-before.observedHeroPracticeLog90Delta,12);
});

test('two captures linked to one actual map remain one map and zero training examples',()=>{
  const f=observationFeatureFixture(),c=structuredClone(f.native.captures[0]!),o=structuredClone(f.observations[0]!),b=structuredClone(f.native.bindings[0]!);
  c.id=randomUUID();c.scenarioId=randomUUID();const s=JSON.parse(c.snapshotText);s.scenarioId=c.scenarioId;c.snapshotText=JSON.stringify(s);
  o.id=randomUUID();o.scenarioId=c.scenarioId;const e=JSON.parse(o.evidenceText);e.selection.scenarioId=c.scenarioId;e.selectionSha256=registryHash(e.selection);
  o.evidenceText=JSON.stringify(e);o.evidenceSha256=registrySha(o.evidenceText);b.id=randomUUID();b.captureId=c.id;
  f.native.captures.push(c);f.native.bindings.push(b);refreshNativeExport(f.native);f.observations.push(o);f.links.push({...f.links[0]!,captureId:c.id,observationId:o.id});
  const r=auditObservationFeatures(f);expect(r.counts).toMatchObject({captures:2,distinctActualMaps:1,featureReadyCaptures:2,distinctFeatureReadyMaps:1,trainingExamples:0});
  expect(r.items.filter((i:{duplicateOf:string|null})=>i.duplicateOf!==null)).toHaveLength(1);
});

test('artifact replay is offline, exclusive and rejects a rehashed numeric result',async()=>{
  const file=fileURLToPath(new URL(`../../../.tools/observation-features-test-${randomUUID()}.json`,import.meta.url));let created=false;
  try{
    const saved=await writeObservationFeatures(observationFeatureFixture(),file);created=true;
    expect((await verifyObservationFeatures(file,saved.sha256)).counts.featureReadyCaptures).toBe(1);
    await expect(writeObservationFeatures(observationFeatureFixture(),file)).rejects.toMatchObject({code:'EEXIST'});
    await expect(verifyObservationFeatures(file,'0'.repeat(64))).rejects.toThrow('external_sha_mismatch');
    const artifact=JSON.parse(await readFile(file,'utf8'));artifact.result.items[0].features.inputs.eloLogit=99;
    const bytes=JSON.stringify(artifact);await writeFile(file,bytes);await expect(verifyObservationFeatures(file,registrySha(bytes))).rejects.toThrow('audit_replay_mismatch');
  }finally{if(created)await unlink(file);}
});
