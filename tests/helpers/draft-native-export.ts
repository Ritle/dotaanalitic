import {draftTargetFixture} from './draft-target.js';
import {registrySha,registryHash} from '../../packages/db/src/index.js';
import {verifyNativeDraft} from '../../apps/api/src/modules/scenarios/draft-native-verify.js';
export function nativeExportFixture(){
  const source=draftTargetFixture(),item=source.items[0]!,capture=item.capture,candidate=item.candidates[0]!;
  const ownerId='123e4567-e89b-42d3-a456-426614174099';
  const snapshotText=JSON.stringify(capture.snapshot);
  const evidenceText=JSON.stringify({format:'owner-draft-native-evidence-v1',candidate,
    result:verifyNativeDraft({capture,matchId:candidate.matchId,inspectedAt:source.inspectedAt,candidate})});
  return {format:'native-draft-export-source-v1',syntheticOnly:true,exportedAt:'2026-01-03T00:00:00.000000Z',
    captures:[{id:capture.id,ownerId,scenarioId:capture.snapshot.scenarioId,revision:1,recordedAt:capture.recordedAt,snapshotText,snapshotSha256:registrySha(snapshotText)}],
    bindings:[{id:'123e4567-e89b-42d3-a456-426614174010',ownerId,captureId:capture.id,matchId:candidate.matchId,status:'verified',
      inspectedAt:source.inspectedAt,recordedAt:source.inspectedAt,evidenceText,evidenceSha256:registrySha(evidenceText)}]};
}
export function refreshNativeExport(f:ReturnType<typeof nativeExportFixture>){
  for(const row of f.captures){
    const snapshot=JSON.parse(row.snapshotText),{status:_status,sha256:_sha,...history}=snapshot.history;
    snapshot.history.sha256=registryHash(history);row.snapshotText=JSON.stringify(snapshot);row.snapshotSha256=registrySha(row.snapshotText);
    for(const b of f.bindings.filter(b=>b.captureId===row.id)){
      const evidence=JSON.parse(b.evidenceText),capture={id:row.id,sha256:row.snapshotSha256,recordedAt:row.recordedAt,snapshot};
      evidence.result=verifyNativeDraft({capture,matchId:b.matchId,inspectedAt:b.inspectedAt,candidate:evidence.candidate});
      b.status=evidence.result.status;b.evidenceText=JSON.stringify(evidence);b.evidenceSha256=registrySha(b.evidenceText);
    }
  }return f;
}
