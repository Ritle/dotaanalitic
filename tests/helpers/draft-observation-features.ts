import {nativeExportFixture} from './draft-native-export.js';
import {registryHash,registrySha} from '../../packages/db/src/index.js';
import {DraftHistoryEvidenceSchema} from '../../apps/api/src/modules/scenarios/draft-history-contract.js';
export function observationFeatureFixture(){
  const native=nativeExportFixture(),c=native.captures[0]!,snapshot=JSON.parse(c.snapshotText);
  const players=snapshot.players as {playerId:string;accountId:string;heroId:number}[];
  const readAt='2026-01-01T11:59:58.000000Z',observedAt='2026-01-01T11:59:58.000001Z';
  const us=(s:string)=>String(BigInt(Date.parse(s))*1000n);
  const maps=Array.from({length:6},(_,i)=>({id:String(1001+i),series_id:`123e4567-e89b-42d3-a456-42661417500${i}`,
    started_at_us:us(`2025-12-${25+i}T10:00:00.000Z`),synced_at_us:us(`2025-12-${25+i}T11:00:00.000Z`),
    duration_seconds:600,radiant_win:i!==2,is_pro:true,ingest_state:'accepted',data_revision:'1',patch_id:null,
    radiant_team_id:snapshot.scenario.teamAId,dire_team_id:snapshot.scenario.teamBId}));
  const receipts=maps.map((m,i)=>({id:String(i+1),canonical_match_id:m.id,provider:'opendota',provider_match_id:m.id,
    adapter_version:'synthetic-v1',normalizer_version:'synthetic-v1',payload_sha256:'a'.repeat(64),context_sha256:'b'.repeat(64),
    status:'accepted',reasons:[],event_at_us:null,known_at_us:null,fetched_at_us:m.synced_at_us}));
  const identities=players.map(p=>({observationId:'synthetic:'+p.playerId,playerId:p.playerId,externalAccountId:p.accountId,
    provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:'2025-01-01T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:'+p.accountId}));
  const body={format:'draft-history-projection-v1',sourcePayloadsIncluded:false,fieldObservationsIncluded:false,
    scope:'all_local_pro_before_decision_remote_completeness_unknown',maps,receipts,identities,
    players:maps.flatMap(m=>players.map((p,i)=>({match_id:m.id,player_slot:i<5?i:i+123,side:i<5?'radiant':'dire',
      player_id:p.playerId,source_account_id:p.accountId,hero_id:i===0?20:p.heroId}))),
    series:maps.map(m=>({id:m.series_id,provider:'opendota',provider_series_id:m.id,team_a_id:m.radiant_team_id,team_b_id:m.dire_team_id}))};
  const outcomes=maps.map((m,i)=>({status:'verified',matchId:m.id,outcomeReceiptId:receipts[i]!.id,teamAId:m.radiant_team_id,teamBId:m.dire_team_id,
    teamAWon:m.radiant_win,startedAt:new Date(Number(BigInt(m.started_at_us)/1000n)).toISOString(),
    completedAt:new Date(Number(BigInt(m.started_at_us)/1000n)+600000).toISOString(),seriesId:m.series_id,dataRevision:'1',labelVerifiedAt:readAt.slice(0,23)+'Z',
    sourceEvidence:{receiptId:receipts[i]!.id,payloadSha256:'a'.repeat(64),adapterVersion:'synthetic-v1',normalizerVersion:'synthetic-v1',
      receiptFetchedAt:new Date(Number(BigInt(m.synced_at_us)/1000n)).toISOString()}}));
  const selection={format:'owner-scenario-selection-v2',scenarioId:c.scenarioId,revision:c.revision,scenarioHash:snapshot.scenarioHash,actualMatchId:null};
  const evidence=DraftHistoryEvidenceSchema.parse({format:'owner-draft-history-observation-v1',selection,selectionSha256:registryHash(selection),
    readAt,observedAt,history:{...body,status:'captured',sha256:registryHash(body)},outcomes,
    verifierMigrations:[{filename:'012_verified_dataset_boundary.sql',sha256:'a'.repeat(64)},{filename:'018_outcome_verifier.sql',sha256:'b'.repeat(64)}],
    basis:'local_receipt_verification',reasons:[],primaryEligible:false,scoringPerformed:false,deployable:false});
  const evidenceText=JSON.stringify(evidence),id='123e4567-e89b-42d3-a456-426614176000';
  return {format:'draft-observation-feature-source-v1' as const,native,observations:[{id,ownerId:c.ownerId,scenarioId:c.scenarioId,revision:1,
    readAt,observedAt,recordedAt:'2026-01-01T11:59:58.000002Z',evidenceText,evidenceSha256:registrySha(evidenceText)}],
    links:[{captureId:c.id,observationId:id,recordedAt:'2026-01-01T12:00:00.000000Z'}]};
}
export function editObservation(f:ReturnType<typeof observationFeatureFixture>,edit:(e:ReturnType<typeof DraftHistoryEvidenceSchema.parse>)=>void){
  const row=f.observations[0]!,e=DraftHistoryEvidenceSchema.parse(JSON.parse(row.evidenceText));edit(e);
  const {status:_status,sha256:_sha,...body}=e.history;e.history.sha256=registryHash(body);e.selectionSha256=registryHash(e.selection);
  row.readAt=e.readAt;row.observedAt=e.observedAt;row.evidenceText=JSON.stringify(e);row.evidenceSha256=registrySha(row.evidenceText);return f;
}
