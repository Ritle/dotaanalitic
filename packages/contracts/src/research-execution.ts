import { z } from 'zod';
import { ResearchEloExportSchema } from './research-elo.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ResearchExecutionCodeSchema = z.array(z.object({
  path: z.string().min(1).max(512), sha256: Sha
}).strict()).min(1).max(256);
export const ResearchExecutionBodySchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('research-elo-execution-v1'),
  planFingerprint: Sha, capturedAt: z.iso.datetime({ precision: 3 }),
  inventoryScope: z.literal('all_local_maps_remote_completeness_unknown'),
  snapshot: ResearchEloExportSchema, executionCode: ResearchExecutionCodeSchema,
  trainingReady: z.literal(false), deployable: z.literal(false)
}).strict();
export const ResearchExecutionSchema = ResearchExecutionBodySchema.extend({ fingerprint: Sha });
