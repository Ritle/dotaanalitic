import {z} from 'zod';
import {V1JournalRowViewSchema} from '../v1-journal-view.js';
import {V1RuntimeSnapshotSchema} from '../v1-runtime.js';
/** Only visible metadata; immutable full bytes are hash-checked before this projection. */
export const V1JournalFeedSnapshotSchema=z.object(V1RuntimeSnapshotSchema.shape).pick({request:true,scenario:true,
  createdAt:true,issuedAt:true,status:true,teamAWinProbability:true,reasons:true}).refine(s=>
  s.status==='done'?s.teamAWinProbability!==null&&s.issuedAt!==null&&s.reasons.length===0:
    s.teamAWinProbability===null&&s.issuedAt===null&&s.reasons.length>0);
export const V1JournalFeedCursorSchema=z.object({createdAt:z.iso.datetime({precision:6}),id:z.uuid()}).strict();
export const V1JournalFeedSchema=z.object({readAt:z.iso.datetime(),items:z.array(z.object({
  predictionId:z.uuid(),requestId:z.uuid(),createdAt:z.iso.datetime({precision:6}),
  scenario:V1JournalRowViewSchema.shape.scenario,target:V1JournalRowViewSchema.shape.target,
  expectedLineups:V1JournalRowViewSchema.shape.expectedLineups,
  probability:z.number().min(0).max(1).nullable(),calculationStatus:z.enum(['done','unavailable']),
  status:z.enum(['eligible','what_if','unavailable','pending_verification','excluded','cancelled']),
  actualWinner:z.enum(['A','B']).nullable(),sourceChangedSinceRefresh:z.boolean(),
  checkedAt:z.iso.datetime().nullable(),reasons:z.array(z.string())
}).strict()).max(50),nextCursor:V1JournalFeedCursorSchema.nullable()}).strict();
export type V1JournalFeedCursor=z.infer<typeof V1JournalFeedCursorSchema>;
