import {z} from 'zod';
import {SelectedPlayerHistoryRequestSchema,PlayerHistoryResponseSchema,CatalogIdSchema} from '@dota/contracts';
export const comparisonHistoryOptions={windowDays:365,maxMaps:25} as const;
export const minimumComparisonHistory=5;
export const needsComparisonHistory=(counts:readonly (number|null)[])=>counts.length!==5||counts.some(n=>n===null||n<minimumComparisonHistory);
export const ComparisonHistoryRequestSchema=z.object({lineupA:SelectedPlayerHistoryRequestSchema.shape.playerIds,lineupB:SelectedPlayerHistoryRequestSchema.shape.playerIds,cutoffAt:z.iso.datetime().optional()}).strict()
 .refine(v=>new Set([...v.lineupA,...v.lineupB]).size===10,'Ten distinct canonical players required');
export type ComparisonHistoryRequest=z.infer<typeof ComparisonHistoryRequestSchema>;
export const ComparisonHistoryResponseSchema=z.object({policyVersion:z.literal('comparison-history-v1'),checkedAt:z.iso.datetime(),minimumMaps:z.literal(5),
 options:z.object({windowDays:z.literal(365),maxMaps:z.literal(25)}),
 groups:z.array(z.object({slot:z.enum(['A','B']),playerIds:SelectedPlayerHistoryRequestSchema.shape.playerIds,
 coverage:z.array(z.object({playerId:CatalogIdSchema,nRaw:z.number().int().nonnegative()})).length(5).nullable(),
 state:z.enum(['covered','queued','running','completed','partial','error','unavailable','historical']),history:PlayerHistoryResponseSchema.nullable(),message:z.string().max(500)})).length(2)}).strict();
export type ComparisonHistoryResponse=z.infer<typeof ComparisonHistoryResponseSchema>;
