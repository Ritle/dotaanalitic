import {z} from 'zod';
import {CaptureTimeSchema} from './draft-capture-contract.js';
const Count=z.number().int().nonnegative();
export const DraftHistorySummarySchema=z.object({
  status:z.enum(['saved','unavailable','missing']),recordedAt:CaptureTimeSchema.nullable(),
  readAt:CaptureTimeSchema.nullable(),maps:Count.nullable(),verifiedMaps:Count.nullable(),
  excludedMaps:Count.nullable(),reasons:z.array(z.string()),forecastStatus:z.literal('unavailable')
}).strict();
