import {z} from 'zod';
import {CatalogIdSchema} from '@dota/contracts';
import {registryHash} from '@dota/db';
import {CaptureTimeSchema,DraftCaptureHistorySchema} from './draft-capture-contract.js';
import {captureMicros} from './draft-target-resolution.js';
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Id=CatalogIdSchema,Ms=z.iso.datetime({precision:3});
export const DraftHistoryProjectionSchema=DraftCaptureHistorySchema.omit({receipts:true,facts:true}).extend({
  format:z.literal('draft-history-projection-v1'),sourcePayloadsIncluded:z.literal(false),fieldObservationsIncluded:z.literal(false),
  receipts:z.array(DraftCaptureHistorySchema.shape.receipts.element.omit({source_payload:true})).max(10000)
}).strict();
export type DraftHistoryProjection=z.infer<typeof DraftHistoryProjectionSchema>;
const Verified=z.object({status:z.literal('verified'),matchId:Id,outcomeReceiptId:Id,teamAId:Id,teamBId:Id,teamAWon:z.boolean(),
  startedAt:Ms,completedAt:Ms,seriesId:z.uuid().nullable(),dataRevision:z.string().regex(/^\d+$/),labelVerifiedAt:Ms,
  sourceEvidence:z.object({receiptId:Id,payloadSha256:Hash,adapterVersion:z.string(),normalizerVersion:z.string(),receiptFetchedAt:Ms}).strict()}).strict();
export const DraftHistoryOutcomeSchema=z.discriminatedUnion('status',[Verified,
  z.object({status:z.literal('unavailable'),matchId:Id,reasons:z.array(z.string()).min(1)}).strict()]);
// The owner selection is immutable independently of a later actual-map association.
export const DraftHistorySelectionSchema=z.object({format:z.literal('owner-scenario-selection-v2'),
  scenarioId:z.uuid(),revision:z.number().int().positive(),scenarioHash:Hash,actualMatchId:z.null()}).strict();
export const DraftHistoryEvidenceSchema=z.object({format:z.literal('owner-draft-history-observation-v1'),
  selection:DraftHistorySelectionSchema,selectionSha256:Hash,readAt:CaptureTimeSchema,observedAt:CaptureTimeSchema,
  history:DraftHistoryProjectionSchema,outcomes:z.array(DraftHistoryOutcomeSchema).max(5000),
  verifierMigrations:z.array(z.object({filename:z.enum(['012_verified_dataset_boundary.sql','018_outcome_verifier.sql']),sha256:Hash}).strict()).length(2),
  basis:z.literal('local_receipt_verification'),reasons:z.array(z.string()),
  primaryEligible:z.literal(false),scoringPerformed:z.literal(false),deployable:z.literal(false)
}).strict().superRefine((e,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message});
  if(e.selectionSha256!==registryHash(e.selection))fail('selection_hash');
  const {status:_status,sha256,...body}=e.history;if(registryHash(body)!==sha256)fail('history_hash');
  const read=captureMicros(e.readAt);if(read>captureMicros(e.observedAt))fail('observation_clock');
  const maps=new Map(e.history.maps.map(m=>[m.id,m]));
  if(maps.size!==e.history.maps.length||new Set(e.outcomes.map(o=>o.matchId)).size!==e.outcomes.length||maps.size!==e.outcomes.length)fail('outcome_inventory');
  if(new Set(e.verifierMigrations.map(m=>m.filename)).size!==2)fail('verifier_inventory');
  for(const m of maps.values())if(BigInt(m.started_at_us)>=read||BigInt(m.synced_at_us)>=read)fail('history_clock');
  for(const r of e.history.receipts)if(BigInt(r.fetched_at_us)>=read)fail('receipt_clock');
  for(const o of e.outcomes){
    const m=maps.get(o.matchId);if(!m){fail('foreign_outcome');continue;}
    if(o.status!=='verified')continue;
    const receipt=e.history.receipts.find(r=>r.id===o.outcomeReceiptId);
    if(!receipt||receipt.canonical_match_id!==m.id||receipt.provider!=='opendota'||receipt.payload_sha256!==o.sourceEvidence.payloadSha256||
      receipt.id!==o.sourceEvidence.receiptId||receipt.adapter_version!==o.sourceEvidence.adapterVersion||receipt.normalizer_version!==o.sourceEvidence.normalizerVersion)
      fail('outcome_receipt');
    if(m.radiant_win!==o.teamAWon||m.radiant_team_id!==o.teamAId||m.dire_team_id!==o.teamBId||m.series_id!==o.seriesId||m.data_revision!==o.dataRevision||
      BigInt(Date.parse(o.startedAt))*1000n!==BigInt(m.started_at_us)||m.duration_seconds===null||m.duration_seconds<=0||
      BigInt(Date.parse(o.completedAt))*1000n!==BigInt(m.started_at_us)+BigInt(m.duration_seconds??0)*1000000n||
      BigInt(Date.parse(o.completedAt))*1000n>read||Date.parse(o.labelVerifiedAt)!==Number(read/1000n))fail('outcome_map');
  }
});
export type DraftHistoryEvidence=z.infer<typeof DraftHistoryEvidenceSchema>;
export const DraftHistorySavedSchema=z.object({id:z.uuid(),recordedAt:CaptureTimeSchema,sha256:Hash,evidence:DraftHistoryEvidenceSchema}).strict()
  .superRefine((o,ctx)=>{if(captureMicros(o.recordedAt)<captureMicros(o.evidence.observedAt))ctx.addIssue({code:'custom',message:'persistence_clock'});});
export type DraftHistorySaved=z.infer<typeof DraftHistorySavedSchema>;
