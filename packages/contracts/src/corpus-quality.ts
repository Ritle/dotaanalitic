import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
const Time=z.iso.datetime({precision:6});
const Status=z.enum(['eligible','ineligible','unknown']);
export const CorpusQualityRequestSchema=z.object({fromAt:z.iso.datetime({precision:3}),toAt:z.iso.datetime({precision:3})})
  .strict().refine(v=>v.fromAt<v.toAt,{message:'invalid_quality_window'});
export const CorpusQualityRowSchema=z.object({matchId:Id,startedAt:Time,syncedAt:Time,dataRevision:z.string().regex(/^\d+$/),
  ingestState:z.enum(['accepted','partial','conflict']),canonicalPatchId:Id.nullable(),leagueId:Id.nullable(),
  providerPatchId:z.string().regex(/^\d+$/).nullable(),
  quality:z.object({outcome:Status,players:Status,heroes:Status,teams:Status,series:Status,
    timeline:z.enum(['unknown','structurally_inconsistent','missing','verified'])}).strict(),
  anomalies:z.array(z.string()),assessment:z.object({id:Id,validatorVersion:z.string(),assessedAt:Time,
    sourceSnapshotId:Id.nullable(),provider:z.string().nullable(),receipt:z.object({id:Id,
      payloadSha256:z.string().regex(/^[a-f0-9]{64}$/),fetchedAt:Time,normalizerVersion:z.string()}).strict().nullable()}).strict().nullable()
}).strict();
export type CorpusQualityRow=z.infer<typeof CorpusQualityRowSchema>;
