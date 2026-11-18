import {test,expect} from 'vitest';
import {registryHash} from '@dota/db';
import {draftTargetFixture} from '../../../tests/helpers/draft-target.js';
import {DraftHistoryEvidenceSchema,DraftHistorySavedSchema} from '../src/modules/scenarios/draft-history-contract.js';
function fixture(){
  const c=draftTargetFixture().items[0]!.capture;
  const {sha256:_sha,status,facts:_facts,...old}=c.snapshot.history;
  const body={...old,receipts:[],format:'draft-history-projection-v1' as const,sourcePayloadsIncluded:false as const,fieldObservationsIncluded:false as const};
  const history={...body,status,sha256:registryHash(body)};
  const selection={format:'owner-scenario-selection-v2' as const,scenarioId:c.snapshot.scenarioId,revision:1,scenarioHash:c.snapshot.scenarioHash,actualMatchId:null};
  return {format:'owner-draft-history-observation-v1' as const,selection,selectionSha256:registryHash(selection),
    readAt:'2026-01-01T11:59:58.000001Z',observedAt:'2026-01-01T11:59:58.000002Z',history,outcomes:[],
    verifierMigrations:[{filename:'012_verified_dataset_boundary.sql',sha256:'a'.repeat(64)},{filename:'018_outcome_verifier.sql',sha256:'b'.repeat(64)}],
    basis:'local_receipt_verification' as const,reasons:[],primaryEligible:false,scoringPerformed:false,deployable:false};
}
test('empty history remains empty and nondeployable; target binding is independent of selection',()=>{
  const f=fixture(),r=DraftHistoryEvidenceSchema.parse(f);expect(r.outcomes).toEqual([]);expect(r.history.status).toBe('unavailable');
  expect(r.selection.actualMatchId).toBeNull();expect(r.deployable).toBe(false);expect(f).toEqual(r);
  expect(()=>DraftHistoryEvidenceSchema.parse({...f,selection:{...f.selection,actualMatchId:'123'}})).toThrow();
});
test('submillisecond read, observation and persistence ordering is enforced',()=>{
  const f=fixture();expect(()=>DraftHistoryEvidenceSchema.parse({...f,observedAt:'2026-01-01T11:59:58.000000Z'})).toThrow('observation_clock');
  const saved={id:'123e4567-e89b-42d3-a456-426614174001',sha256:'f'.repeat(64),recordedAt:'2026-01-01T11:59:58.000003Z',evidence:f};
  expect(DraftHistorySavedSchema.parse(saved).recordedAt).toBe(saved.recordedAt);
  expect(()=>DraftHistorySavedSchema.parse({...saved,recordedAt:f.readAt})).toThrow('persistence_clock');
});
test('corrupt history, selection or verifier provenance fails closed',()=>{
  const f=fixture();
  for(const bad of [{...f,history:{...f.history,sha256:'0'.repeat(64)}},{...f,selectionSha256:'0'.repeat(64)},
    {...f,verifierMigrations:[f.verifierMigrations[0],f.verifierMigrations[0]]},{...f,primaryEligible:true}])
    expect(()=>DraftHistoryEvidenceSchema.parse(bad)).toThrow();
});
test('outcome inventory cannot add foreign maps or turn an empty sample into a verified result',()=>{
  const f=fixture();expect(()=>DraftHistoryEvidenceSchema.parse({...f,outcomes:[{status:'unavailable',matchId:'123',reasons:['MAP_NOT_FOUND']}]})).toThrow('outcome_inventory');
  expect(()=>DraftHistoryEvidenceSchema.parse({...f,outcomes:[{status:'verified',matchId:'123'}]})).toThrow();
});
