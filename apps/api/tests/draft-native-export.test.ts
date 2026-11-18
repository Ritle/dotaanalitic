import {test,expect} from 'vitest';
import {nativeExportFixture,refreshNativeExport} from '../../../tests/helpers/draft-native-export.js';
import {compileNativeExportRuntime} from '../../../tests/helpers/native-export-runtime.js';
import {registrySha} from '@dota/db';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
compileNativeExportRuntime();
const {auditNativeExport}=await import('../../../tools/audits/draft-native-export-core.mjs');
const {writeNativeExport,verifyNativeExport}=await import('../../../tools/audits/draft-native-export.mjs');
test('exports empty inventory honestly; no synthetic fallback or probabilities',()=>{
  const f=nativeExportFixture();f.captures=[];f.bindings=[];f.syntheticOnly=false;
  const r=auditNativeExport(f);expect(r.counts).toMatchObject({captures:0,distinctActualMaps:0,trainingExamples:0});
  expect(r.syntheticOnly).toBe(false);expect(r.teamAWinProbability).toBeNull();
});
test('replays a native binding and invokes old feature contract without inventing observations',()=>{
  const f=nativeExportFixture(),before=structuredClone(f),r=auditNativeExport(f),row=r.items[0];
  expect(row.actualMatchId).toBe(f.bindings[0]!.matchId);expect(row.diagnosticRepresentative).toBe(true);
  expect(row.featureCheck).toMatchObject({status:'unavailable',mode:'missing_evidence_probe',trustedHistoryMaps:0,inputs:null});
  expect(row.featureCheck.reasons).toContain('DRAFT_OBSERVATION_MISSING');
  expect(row.primaryEligible).toBe(false);expect(f).toEqual(before);expect(Object.isFrozen(r)).toBe(true);
});
test('multiple captures of one map use earliest recorded capture, independent of transport order',()=>{
  const f=nativeExportFixture(),second=structuredClone(f.captures[0]!),binding=structuredClone(f.bindings[0]!);
  second.id='123e4567-e89b-42d3-a456-426614174002';second.scenarioId='123e4567-e89b-42d3-a456-426614174003';
  second.recordedAt='2026-01-01T12:00:00.000001Z';const snapshot=JSON.parse(second.snapshotText);snapshot.scenarioId=second.scenarioId;second.snapshotText=JSON.stringify(snapshot);
  binding.id='123e4567-e89b-42d3-a456-426614174011';binding.captureId=second.id;
  f.captures.push(second);f.bindings.push(binding);refreshNativeExport(f);
  const r=auditNativeExport(f);expect(r.counts).toMatchObject({captures:2,verifiedBindings:2,distinctActualMaps:1,duplicateCaptures:1,trainingExamples:0});
  expect(r.maps[0].representativeCaptureId).toBe(f.captures[0]!.id);
  f.captures.reverse();f.bindings.reverse();expect(auditNativeExport(f)).toEqual(r);
  expect(r.items.find((i:{captureId:string})=>i.captureId===second.id).reasons).toContain('CAPTURE_NOT_BEFORE_PROVIDER_START');
});
test('unbound and unavailable attempts remain in the ledger',()=>{
  const f=nativeExportFixture();const e=JSON.parse(f.bindings[0]!.evidenceText);e.candidate=null;f.bindings[0]!.evidenceText=JSON.stringify(e);refreshNativeExport(f);
  const r=auditNativeExport(f);expect(r.items[0].attempts).toHaveLength(1);expect(r.items[0].reasons).toContain('VERIFIED_NATIVE_BINDING_MISSING');
  expect(r.counts.distinctActualMaps).toBe(0);
  f.bindings=[];expect(auditNativeExport(f).items[0].attempts).toEqual([]);
});
test('all frozen historical map IDs retained; target outcomes never become trusted inputs',()=>{
  const f=nativeExportFixture(),row=f.captures[0]!,s=JSON.parse(row.snapshotText);
  s.history.maps=[{id:f.bindings[0]!.matchId,series_id:null,started_at_us:'1767268800000000',synced_at_us:'1767272400000000',
    duration_seconds:600,radiant_win:true,is_pro:true,ingest_state:'accepted',data_revision:'1',patch_id:null,radiant_team_id:s.scenario.teamAId,dire_team_id:s.scenario.teamBId}];
  row.snapshotText=JSON.stringify(s);refreshNativeExport(f);
  const result=auditNativeExport(f).items[0];expect(result.frozenHistoryMaps).toBe(1);
  expect(result.historyLedger[0].reasons).toContain('TARGET_MAP_EXCLUDED');expect(result.featureCheck.trustedHistoryMaps).toBe(0);
  expect(result.historyLedger[0].reasons).toContain('OUTCOME_VERIFICATION_OBSERVATION_NOT_CAPTURED');
});
test('tampered result rejected even after recomputing raw evidence SHA',()=>{
  const f=nativeExportFixture(),b=f.bindings[0]!,e=JSON.parse(b.evidenceText);e.result.teamASide='dire';b.evidenceText=JSON.stringify(e);b.evidenceSha256=registrySha(b.evidenceText);
  expect(()=>auditNativeExport(f)).toThrow('binding_replay_mismatch');
});
test('foreign references, future clocks, duplicate IDs and multiple success records reject entire export',()=>{
  for(const mutate of [
    (f:ReturnType<typeof nativeExportFixture>)=>{f.bindings[0]!.ownerId='123e4567-e89b-42d3-a456-426614174098';},
    (f:ReturnType<typeof nativeExportFixture>)=>{f.bindings[0]!.recordedAt='2027-01-01T00:00:00.000000Z';},
    (f:ReturnType<typeof nativeExportFixture>)=>{f.captures.push(f.captures[0]!);},
    (f:ReturnType<typeof nativeExportFixture>)=>{f.bindings.push({...f.bindings[0]!,id:'123e4567-e89b-42d3-a456-426614174011'});},
    (f:ReturnType<typeof nativeExportFixture>)=>{f.captures[0]!.snapshotText='{}';}
  ]){const f=nativeExportFixture();mutate(f);expect(()=>auditNativeExport(f)).toThrow();}
});

test('exclusive export, external hash and offline replay detect independently rehashed corruption',async()=>{
  const file=fileURLToPath(new URL(`../../../.tools/native-export-test-${randomUUID()}.json`,import.meta.url));
  let created=false;
  try{
    const saved=await writeNativeExport(nativeExportFixture(),file);created=true;
    const original=await readFile(file,'utf8');
    expect((await verifyNativeExport(file,saved.sha256)).counts.distinctActualMaps).toBe(1);
    await expect(writeNativeExport(nativeExportFixture(),file)).rejects.toMatchObject({code:'EEXIST'});
    await expect(verifyNativeExport(file,'0'.repeat(64))).rejects.toThrow('external_sha_mismatch');
    for(const field of ['result','source','environment']){
      const artifact=JSON.parse(original);
      if(field==='result')artifact.result.counts.trainingExamples=1;
      if(field==='source')artifact.source.exportedAt='2026-01-04T00:00:00.000000Z';
      if(field==='environment')artifact.environment.node='forged';
      const bytes=JSON.stringify(artifact);await writeFile(file,bytes);
      await expect(verifyNativeExport(file,registrySha(bytes))).rejects.toThrow();
    }
  }finally{if(created)await unlink(file);}
});

test('export refuses output outside private local artifact directory',async()=>{
  await expect(writeNativeExport(nativeExportFixture(),'docs/export-forbidden.json')).rejects.toThrow('local_output_required');
});
