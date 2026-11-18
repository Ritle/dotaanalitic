import {test,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {compileNativeExportRuntime} from '../../../tests/helpers/native-export-runtime.js';
import {observationFeatureFixture,editObservation} from '../../../tests/helpers/draft-observation-features.js';
import {refreshNativeExport} from '../../../tests/helpers/draft-native-export.js';
import {registryHash,registrySha} from '@dota/db';
compileNativeExportRuntime();
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','tools/research/player-hero-shadow-feature.mts',
  'tools/research/player-hero-inference.mts','--strict','--noUncheckedIndexedAccess','--skipLibCheck','--target','ES2022',
  '--module','NodeNext','--moduleResolution','NodeNext','--types','node','--typeRoots','packages/db/node_modules/@types',
  '--outDir','.tools/s304-shadow-runtime'],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),windowsHide:true,stdio:'pipe',timeout:120000});
const {calculateShadow,shadowCandidate}=await import('../../../tools/audits/draft-shadow-core.mjs');
const {writeShadowResult,verifyShadowResult}=await import('../../../tools/audits/draft-shadow.mjs');
const {auditObservationFeatures}=await import('../../../tools/audits/draft-observation-features-core.mjs');
const clock='2026-01-03T00:00:01.000Z';
// Deliberately synthetic coefficients, not a production artifact or quality evidence.
const candidate=()=>({format:'player-hero-research-fit-v1',syntheticOnly:true,deployable:false,
  models:{H1:{status:'fitted',featureOrder:['eloLogit'],coefficients:[.8],intercept:0,calibration:{status:'fitted',temperature:.9}},
    H2:{status:'fitted',featureOrder:['eloLogit','observedHeroPracticeLog90Delta'],coefficients:[.75,.13],intercept:0,
      calibration:{status:'fitted',temperature:.85}}}});
const score=(f=fixture())=>calculateShadow(f,JSON.stringify(candidate()),clock);

function fixture(){
  const f=observationFeatureFixture();
  editObservation(f,e=>{
    const original=structuredClone(e.history),outcomes=structuredClone(e.outcomes);
    for(const p of original.identities)e.history.identities.push({...p,observationId:p.observationId+':opponent',
      playerId:String(BigInt(p.playerId)+1000n),externalAccountId:String(BigInt(p.externalAccountId!)+1000n)});
    // Six games for each selected five against different opponents: no target encounter.
    for(const p of e.history.players)if(p.side==='dire'){
      p.player_id=String(BigInt(p.player_id!)+1000n);p.source_account_id=String(BigInt(p.source_account_id!)+1000n);
    }
    for(const m of original.maps){
      const id=String(BigInt(m.id)+1000n);e.history.maps.push({...m,id});
      const r=original.receipts.find(r=>r.canonical_match_id===m.id)!;
      e.history.receipts.push({...r,id:String(BigInt(r.id)+1000n),canonical_match_id:id,provider_match_id:id});
      for(const p of original.players.filter(p=>p.match_id===m.id))e.history.players.push({...p,match_id:id,
        player_id:p.side==='radiant'?String(BigInt(p.player_id!)+1000n):p.player_id,
        source_account_id:p.side==='radiant'?String(BigInt(p.source_account_id!)+1000n):p.source_account_id});
      const o=outcomes.find(o=>o.matchId===m.id)!;if(o.status!=='verified')throw Error('fixture');
      e.outcomes.push({...o,matchId:id,outcomeReceiptId:String(BigInt(r.id)+1000n),
        sourceEvidence:{...o.sourceEvidence,receiptId:String(BigInt(r.id)+1000n)}});
    }
  });
  return f;
}

test('pending and later bound targets have identical frozen inputs and scores without fake IDs',()=>{
  const f=fixture(),bound=score(f);f.native.bindings=[];const before=structuredClone(f),pending=score(f);
  expect(pending.items[0].actualMatchId).toBeNull();expect(pending.items[0].shadowStatus).toBe('computed_shadow_only');
  expect(pending.items[0].features.heroSnapshot.scenario.targetMatchId).toBeNull();
  expect(pending.items[0].inputFingerprint).toBe(bound.items[0].inputFingerprint);
  expect(pending.items[0].researchScores).toEqual(bound.items[0].researchScores);
  expect(pending.items[0].features.coverage.nRaw).toBe(12);
  expect(pending.counts).toMatchObject({scoredCaptures:1,distinctFeatureReadyMaps:0,trainingExamples:0});
  expect(pending.teamAWinProbability).toBeNull();expect(pending.primaryEligible).toBe(false);expect(pending.deployable).toBe(false);
  expect(f).toEqual(before);expect(Object.isFrozen(pending.items[0].researchScores)).toBe(true);
});

test('new adapter retains original numerical inputs when no selected-ten encounter is present',()=>{
  const f=fixture(),r=score(f),old=auditObservationFeatures(f);
  expect(r.items[0].features.inputs).toEqual(old.items[0].features.inputs);
  expect(r.items[0].features.inputs.observedHeroPracticeLog90Delta).toBeCloseTo(-Math.log1p(6)/5,12);
});

test('same ten and their whole known series are excluded before consuming a target outcome',()=>{
  const f=fixture();editObservation(f,e=>{
    const selected=JSON.parse(f.native.captures[0]!.snapshotText).players as {accountId:string;playerId:string}[];
    for(const p of e.history.players.filter(p=>p.match_id==='1001')){
      const i=p.player_slot<128?p.player_slot:p.player_slot-123;
      p.player_id=selected[i]!.playerId;p.source_account_id=selected[i]!.accountId;
    }
  });
  const first=score(f).items[0];expect(first.features.coverage.nRaw).toBe(10);
  expect(first.features.mapLedger.filter((m:{included:boolean})=>!m.included)).toHaveLength(2);
  expect(first.features.mapLedger[0].reasons).toContain('SELECTED_TEN_ENCOUNTER_EXCLUDED');
  editObservation(f,e=>{e.history.maps[0]!.radiant_win=false;e.outcomes[0]={status:'unavailable',matchId:'1001',reasons:['LABEL_MUST_NOT_BE_USED']};});
  expect(score(f).items[0].researchScores).toEqual(first.researchScores);
});

test('when exclusions exhaust history, scores are unavailable rather than fabricated 50/50',()=>{
  const r=score(observationFeatureFixture());expect(r.items[0].researchScores).toBeNull();
  expect(r.items[0].calculationReasons).toContain('INSUFFICIENT_PLAYER_HISTORY');expect(r.scoringPerformed).toBe(false);
});

test('missing linked history and identity conflict block scoring',()=>{
  const f=fixture();f.links=[];expect(score(f).items[0].calculationReasons).toContain('PRE_CUTOFF_HISTORY_OBSERVATION_MISSING');
  const g=fixture();editObservation(g,e=>{e.history.identities.push({...e.history.identities[0]!,observationId:'conflict',status:'rejected'});});
  expect(score(g).items[0].researchScores).toBeNull();
});

test('invalid clocks fail closed; missing outcomes close the entire known series',()=>{
  for(const mode of ['cutoff','receipt','outcome']){
    const f=fixture();editObservation(f,e=>{
      if(mode==='cutoff')e.history.maps[0]!.started_at_us=String(BigInt(Date.parse('2026-01-01T12:00:00Z'))*1000n);
      if(mode==='receipt')e.history.receipts[0]!.fetched_at_us=String(BigInt(Date.parse(e.readAt))*1000n);
      if(mode==='outcome')e.outcomes[0]={status:'unavailable',matchId:'1001',reasons:['NO_OUTCOME']};
    });
    if(mode==='outcome')expect(score(f).items[0].features.coverage.nRaw).toBe(10);
    else expect(()=>score(f)).toThrow();
  }
});

test('unknown historical heroes remain explicit observed zero with missingness warnings',()=>{
  const f=fixture();editObservation(f,e=>{for(const p of e.history.players)p.hero_id=null;});
  const r=score(f).items[0];expect(r.features.inputs.observedHeroPracticeLog90Delta).toBe(0);
  expect(r.features.heroSnapshot.warnings).toContain('HERO_HISTORY_INCOMPLETE');expect(r.researchScores).not.toBeNull();
});

test('swapping A/B complements shadow scores; history row order does not matter',()=>{
  const f=fixture(),first=score(f).items[0].researchScores;
  editObservation(f,e=>{e.history.maps.reverse();e.history.players.reverse();});expect(score(f).items[0].researchScores).toEqual(first);
  const c=f.native.captures[0]!,s=JSON.parse(c.snapshotText);
  [s.scenario.teamAId,s.scenario.teamBId]=[s.scenario.teamBId,s.scenario.teamAId];
  [s.scenario.lineupA,s.scenario.lineupB]=[s.scenario.lineupB,s.scenario.lineupA];
  for(const p of s.scenario.draft.assignments)p.teamSlot=p.teamSlot==='A'?'B':'A';
  for(const p of s.players)p.teamSlot=p.teamSlot==='A'?'B':'A';
  s.scenarioHash=registrySha(JSON.stringify(s.scenario));c.snapshotText=JSON.stringify(s);refreshNativeExport(f.native);
  editObservation(f,e=>{e.selection.scenarioHash=s.scenarioHash;e.selectionSha256=registryHash(e.selection);});
  const second=score(f).items[0].researchScores;
  for(const name of ['H0','H1','H2'])expect(second[name].calibratedProbability+first[name].calibratedProbability).toBeCloseTo(1,12);
});

test('candidate mutation, absent calibrator and synthetic-to-real scoring fail closed',()=>{
  const a=candidate();a.syntheticOnly=false;expect(()=>shadowCandidate(JSON.stringify(a),true)).toThrow('frozen_candidate_sha_mismatch');
  a.syntheticOnly=true;expect(()=>shadowCandidate(JSON.stringify(a),false)).toThrow('synthetic_candidate_on_real_source');
  a.models.H2.calibration.status='insufficient';expect(()=>shadowCandidate(JSON.stringify(a),true)).toThrow('calibrator_unavailable');
  a.models.H2.calibration.status='fitted';a.models.H2.featureOrder.reverse();expect(()=>shadowCandidate(JSON.stringify(a),true)).toThrow();
});

test('bad SHA, foreign owner and duplicate links fail before scoring; no future export clock',()=>{
  const f=fixture();f.observations[0]!.evidenceSha256='a'.repeat(64);expect(()=>score(f)).toThrow();
  const g=fixture();g.observations[0]!.ownerId=randomUUID();expect(()=>score(g)).toThrow();
  const h=fixture();h.links.push(h.links[0]!);expect(()=>score(h)).toThrow();
  expect(()=>calculateShadow(fixture(),JSON.stringify(candidate()),'2026-01-02T00:00:00.000Z')).toThrow('calculation_before_export');
});

test('immutable file replays exactly, rejects overwrite and detects independently rehashed score tampering',async()=>{
  const path=fileURLToPath(new URL(`../../../.tools/shadow-test-${randomUUID()}.json`,import.meta.url));
  try{
    const saved=await writeShadowResult(fixture(),JSON.stringify(candidate()),path,clock);
    const replay=await verifyShadowResult(path,saved.sha256);expect(replay.counts.scoredCaptures).toBe(1);
    await expect(writeShadowResult(fixture(),JSON.stringify(candidate()),path,clock)).rejects.toThrow();
    const data=JSON.parse(await readFile(path,'utf8'));data.result.items[0].researchScores.H2.calibratedProbability=.999;
    const text=JSON.stringify(data);await writeFile(path,text);
    await expect(verifyShadowResult(path,saved.sha256)).rejects.toThrow('external_sha_mismatch');
    await expect(verifyShadowResult(path,registrySha(text))).rejects.toThrow('shadow_replay_mismatch');
  }finally{await unlink(path).catch(()=>{});}
});
