import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
import {RankedPracticeMapSchema} from './ranked-practice.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const RANKED_CONTEXT_POLICY='stratz-known-ranked-map-v1' as const;
export const RankedContextRequestSchema=z.object({playerId:Id,parentObservationId:z.uuid(),refresh:z.boolean().default(false)}).strict();
export const RankedContextSourceEntrySchema=z.object({matchId:Id,status:z.enum(['found','missing','invalid']),reason:z.string().max(60).nullable(),map:RankedPracticeMapSchema.nullable()}).strict().superRefine((v,c)=>{
 if(v.status==='found'?(v.map===null||v.map.matchId!==v.matchId||v.reason!==null):(v.map!==null||v.reason===null))c.addIssue({code:'custom',message:'Invalid context source entry'});
 if(v.map&&(v.map.startedAt>=v.map.completedAt||v.map.position!==null&&!/^POSITION_[1-5]$/.test(v.map.position)||v.map.roleBasis!==(v.map.position?'estimated':'unknown')||v.map.patchCode!==null&&!/^[1-9]\d*$/.test(v.map.patchCode)))c.addIssue({code:'custom',message:'Invalid context source metadata'});
});
export const RankedContextReceiptSchema=z.object({policyVersion:z.literal(RANKED_CONTEXT_POLICY),provider:z.literal('stratz'),accountId:Id,knownAt:z.null(),fetchedAt:Time,payloadSha256:Sha,
 entries:z.array(RankedContextSourceEntrySchema).min(1).max(4)}).strict().superRefine((v,c)=>{
 if(new Set(v.entries.map(e=>e.matchId)).size!==v.entries.length||v.entries.some(e=>e.map&&(e.map.accountId!==v.accountId||e.map.completedAt>=v.fetchedAt)))c.addIssue({code:'custom',message:'Invalid context receipt'});
});
export const RankedContextReportMapSchema=z.object({matchId:Id,heroId:Id,startedAt:Time,status:z.enum(['matched','conflict','unavailable','not_loaded']),reason:z.string().max(60).nullable(),
 position:z.string().regex(/^POSITION_[1-5]$/).nullable(),roleBasis:z.enum(['estimated','unknown']),gameVersionCode:z.string().regex(/^[1-9]\d*$/).nullable(),averageRank:z.number().int().positive().nullable(),
 sourceReceiptId:z.uuid().nullable(),sourceParentObservationId:z.uuid().nullable(),sourceFetchedAt:Time.nullable(),sourceSha256:Sha.nullable(),stale:z.boolean()}).strict().superRefine((v,c)=>{
 const sourced=v.sourceReceiptId!==null;
 if(sourced!==Boolean(v.sourceFetchedAt&&v.sourceSha256&&v.sourceParentObservationId)||!sourced&&(v.stale||v.status!=='not_loaded'||v.sourceFetchedAt!==null||v.sourceSha256!==null||v.sourceParentObservationId!==null)||v.status==='matched'&&v.reason!==null||v.status!=='matched'&&(v.position!==null||v.gameVersionCode!==null||v.averageRank!==null)||v.roleBasis!==(v.position?'estimated':'unknown'))c.addIssue({code:'custom',message:'Invalid applied context'});
});
export const RankedContextReportSchema=z.object({playerId:Id,parentObservationId:z.uuid(),accountId:Id.nullable(),identityRevision:z.string().regex(/^\d+$/),provider:z.literal('stratz'),policyVersion:z.literal(RANKED_CONTEXT_POLICY),snapshotAt:Time,
 status:z.enum(['not_loaded','ready','partial','unavailable']),reason:z.string().max(60).nullable(),retryAt:Time.nullable(),parentFromAt:Time.nullable(),parentCutoffAt:Time.nullable(),parentGames:z.number().int().min(0).max(200),
 selectedMaps:z.number().int().min(0).max(20),matchedMaps:z.number().int().min(0).max(20),maps:z.array(RankedContextReportMapSchema).max(20)}).strict().superRefine((v,c)=>{
 if(v.selectedMaps!==v.maps.length||v.selectedMaps>v.parentGames||v.matchedMaps!==v.maps.filter(m=>m.status==='matched').length||new Set(v.maps.map(m=>m.matchId)).size!==v.maps.length||
  v.maps.length&&(!v.accountId||!v.parentFromAt||!v.parentCutoffAt||v.maps.some(m=>m.startedAt<v.parentFromAt!||m.startedAt>=v.parentCutoffAt!))||
  v.maps.some(m=>m.sourceFetchedAt!==null&&m.sourceFetchedAt>v.snapshotAt)||v.status==='ready'&&(v.selectedMaps===0||v.matchedMaps!==v.selectedMaps||v.maps.some(m=>m.stale))||v.status==='not_loaded'&&v.maps.some(m=>m.status!=='not_loaded'))c.addIssue({code:'custom',message:'Invalid ranked context report'});
});
export type RankedContextRequest=z.infer<typeof RankedContextRequestSchema>;
export type RankedContextReceipt=z.infer<typeof RankedContextReceiptSchema>;
export type RankedContextSourceEntry=z.infer<typeof RankedContextSourceEntrySchema>;
export type RankedContextReport=z.infer<typeof RankedContextReportSchema>;
export type RankedContextReportMap=z.infer<typeof RankedContextReportMapSchema>;
