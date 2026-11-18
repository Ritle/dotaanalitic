import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {registrySha} from '@dota/db';
import {compileNativeExportRuntime} from '../../../tests/helpers/native-export-runtime.js';
import {shadowFeatureFixture} from '../../../tests/helpers/draft-shadow.js';
import {refreshNativeExport} from '../../../tests/helpers/draft-native-export.js';
import {editObservation} from '../../../tests/helpers/draft-observation-features.js';
compileNativeExportRuntime();
const {calculateDraftShadow,parseShadowCandidate,shadowImplementationSha}=await import('../dist/modules/scenarios/draft-shadow-runtime.js');
const {auditCommittedShadow}=await import('../../../tools/audits/draft-committed-shadow-core.mjs');
const {writeCommittedShadow,verifyCommittedShadow}=await import('../../../tools/audits/draft-committed-shadow.mjs');
const implementation=await shadowImplementationSha();
const candidateText=JSON.stringify({format:'player-hero-research-fit-v1',syntheticOnly:true,deployable:false,models:{
 H1:{status:'fitted',intercept:0,coefficients:[.8],featureOrder:['eloLogit'],calibration:{status:'fitted',temperature:.9}},
 H2:{status:'fitted',intercept:0,coefficients:[.75,.13],featureOrder:['eloLogit','observedHeroPracticeLog90Delta'],calibration:{status:'fitted',temperature:.85}}}});
function fixture(model=true){
 const history=shadowFeatureFixture(),c=history.native.captures[0]!,o=history.observations[0]!;
 c.id=randomUUID();c.scenarioId=randomUUID();const snapshot=JSON.parse(c.snapshotText);snapshot.scenarioId=c.scenarioId;c.snapshotText=JSON.stringify(snapshot);
 for(const b of history.native.bindings){b.id=randomUUID();b.captureId=c.id;}
 refreshNativeExport(history.native);o.id=randomUUID();o.scenarioId=c.scenarioId;
 editObservation(history,e=>{e.selection.scenarioId=c.scenarioId;});
 history.links[0]!.captureId=c.id;history.links[0]!.observationId=o.id;
 const saved={id:c.id,sha256:c.snapshotSha256,recordedAt:c.recordedAt,snapshot:JSON.parse(c.snapshotText)};
 const observation={id:o.id,sha256:o.evidenceSha256,recordedAt:o.recordedAt,evidence:JSON.parse(o.evidenceText)};
 const result=calculateDraftShadow(saved,observation,model?parseShadowCandidate(candidateText,true):null,'2026-01-01T12:00:01.000000Z',implementation);
 const resultText=JSON.stringify(result),id=randomUUID(),resultSha256=registrySha(resultText);
 return {format:'committed-draft-shadow-source-v1',history,
   runs:[{id,captureId:c.id,ownerId:c.ownerId,resultText,resultSha256,recordedAt:'2026-01-01T12:00:02.000000Z',writerTxid:'100'}],
   receipts:[{runId:id,resultSha256,observedCommittedAt:'2026-01-01T12:00:03.000000Z',observerTxid:'101'}]};
}
const audit=(f:ReturnType<typeof fixture>)=>auditCommittedShadow(f,implementation);
test('replays stored scores exactly and keeps diagnostics ineligible without mutating source',()=>{
 const f=fixture(),before=structuredClone(f),r=audit(f),saved=JSON.parse(f.runs[0]!.resultText);
 expect(r.items[0].researchScores).toEqual(saved.researchScores);expect(r.items[0].frozenInputs).toEqual(saved.features.inputs);
 expect(r.counts).toMatchObject({committedComputed:1,distinctActualMaps:1,distinctCommittedComputedMaps:1,primaryExamples:0,trainingExamples:0});
 expect(r.primaryEligible).toBe(false);expect(r.collectionAllowed).toBe(false);expect(r.teamAWinProbability).toBeNull();expect(f).toEqual(before);expect(Object.isFrozen(r)).toBe(true);
});
test('missing results, unconfirmed commit and unavailable are different states; no new scores are fabricated',()=>{
 const missing=fixture();missing.runs=[];missing.receipts=[];expect(audit(missing).items[0].status).toBe('missing');
 const waiting=fixture();waiting.receipts=[];const r=audit(waiting);expect(r.items[0].status).toBe('awaiting_receipt');expect(r.counts.distinctCommittedComputedMaps).toBe(0);
 const unavailable=audit(fixture(false));expect(unavailable.items[0].status).toBe('unavailable');expect(unavailable.items[0].researchScores).toBeNull();
 expect(unavailable.items[0].reasons).toContain('SHADOW_CANDIDATE_UNAVAILABLE');
});
test('changed scores fail even with new row/receipt hashes; foreign owners and implementation revisions fail closed',()=>{
 const f=fixture(),r=f.runs[0]!,value=JSON.parse(r.resultText);value.researchScores.H2.calibratedProbability=.99;
 r.resultText=JSON.stringify(value);r.resultSha256=registrySha(r.resultText);f.receipts[0]!.resultSha256=r.resultSha256;
 expect(()=>audit(f)).toThrow('committed_shadow_replay_mismatch');
 const owner=fixture();owner.runs[0]!.ownerId=randomUUID();expect(()=>audit(owner)).toThrow('foreign_shadow_owner_or_capture');
 expect(()=>auditCommittedShadow(fixture(),'a'.repeat(64))).toThrow('shadow_implementation_changed');
 const badHash=fixture();badHash.runs[0]!.resultSha256='a'.repeat(64);expect(()=>audit(badHash)).toThrow('shadow_result_sha_mismatch');
});
test('receipt transaction, microsecond order, foreign references and duplicates are verified',()=>{
 for(const kind of ['same_tx','early','late','orphan','duplicate','hash']){
   const f=fixture(),p=f.receipts[0]!;
   if(kind==='same_tx')p.observerTxid=f.runs[0]!.writerTxid;
   if(kind==='early')p.observedCommittedAt='2026-01-01T12:00:01.999999Z';
   if(kind==='late')p.observedCommittedAt='2026-01-03T00:00:00.000001Z';
   if(kind==='orphan')p.runId=randomUUID();if(kind==='duplicate')f.receipts.push({...p});if(kind==='hash')p.resultSha256='a'.repeat(64);
   expect(()=>audit(f)).toThrow();
 }
 const f=fixture();f.runs.push({...f.runs[0]!,id:randomUUID()});expect(()=>audit(f)).toThrow('duplicate_capture_run');
});
test('late native binding preserves frozen scores; one map has one diagnostic representative selected by commit receipt',()=>{
 const a=fixture(),b=fixture(),score=audit(a).items[0].researchScores;
 const unbound=structuredClone(a);unbound.history.native.bindings=[];expect(audit(unbound).items[0].researchScores).toEqual(score);
 expect(audit(unbound).counts.distinctActualMaps).toBe(0);
 b.receipts[0]!.observedCommittedAt='2026-01-01T12:00:02.999999Z';
 a.history.native.captures.push(...b.history.native.captures);a.history.native.bindings.push(...b.history.native.bindings);
 a.history.observations.push(...b.history.observations);a.history.links.push(...b.history.links);a.runs.push(...b.runs);a.receipts.push(...b.receipts);
 const r=audit(a);expect(r.counts).toMatchObject({committedComputed:2,distinctActualMaps:1,distinctCommittedComputedMaps:1});
 expect(r.maps[0].representativeCaptureId).toBe(b.runs[0]!.captureId);
 expect(r.items.find((i:{captureId:string})=>i.captureId===a.runs[0]!.captureId).duplicateOf).toBe(b.runs[0]!.captureId);
 a.runs.reverse();a.receipts.reverse();expect(audit(a)).toEqual(r);
});
test('observation owner/cutoff and synthetic-to-real substitutions cannot bypass source validation',()=>{
 const owner=fixture();owner.history.observations[0]!.ownerId=randomUUID();expect(()=>audit(owner)).toThrow();
 const late=fixture();late.history.observations[0]!.recordedAt='2026-01-01T11:59:59.999998Z';expect(()=>audit(late)).toThrow();
 const link=fixture();link.history.links[0]!.recordedAt='2026-01-01T12:00:01.000001Z';expect(()=>audit(link)).toThrow('shadow_before_history_link');
 const real=fixture();real.history.native.syntheticOnly=false;expect(()=>audit(real)).toThrow('synthetic_result_on_real_source');
});
test('private immutable export verifies offline with no DB, refuses overwrite and detects independently rehashed report tampering',async()=>{
 const path=fileURLToPath(new URL(`../../../.tools/committed-shadow-test-${randomUUID()}.json`,import.meta.url));
 try{
   const saved=await writeCommittedShadow(fixture(),path),r=await verifyCommittedShadow(path,saved.sha256);expect(r.counts.committedComputed).toBe(1);
   await expect(writeCommittedShadow(fixture(),path)).rejects.toThrow();
   const stdout=execFileSync(process.execPath,['tools/audits/draft-committed-shadow.mjs','verify',path,saved.sha256],{
     cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,DATABASE_URL:'invalid-private-url'},encoding:'utf8',windowsHide:true,timeout:30000});
   expect(JSON.parse(stdout).status).toBe('verified');expect(stdout).not.toContain('researchScores');
   const data=JSON.parse(await readFile(path,'utf8'));data.result.counts.primaryExamples=1;const text=JSON.stringify(data);await writeFile(path,text);
   await expect(verifyCommittedShadow(path,saved.sha256)).rejects.toThrow('external_sha_mismatch');
   await expect(verifyCommittedShadow(path,registrySha(text))).rejects.toThrow('committed_audit_replay_mismatch');
 }finally{await unlink(path).catch(()=>{});}
},40000);
test('output outside private artifacts is refused',async()=>{
 await expect(writeCommittedShadow(fixture(),'docs/committed-shadow-forbidden.json')).rejects.toThrow('local_output_required');
});
