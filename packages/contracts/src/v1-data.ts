import { z } from 'zod';
import { ResearchEloBodySchema } from './research-elo.js';

export const V1_DATA_PROFILE = 'pre-match-player-elo-data-v1' as const;
const Time = z.iso.datetime({ precision: 3 });
export const V1DataRequestSchema = z.object({
  schemaVersion: z.literal(1), profile: z.literal(V1_DATA_PROFILE), purpose: z.literal('development_only'),
  fromAt: Time, toAt: Time, snapshotAt: Time, maxMaps: z.number().int().min(1).max(5000)
}).strict().refine(r => r.fromAt < r.toAt && r.toAt <= r.snapshotAt, { message: 'invalid_v1_data_windows' });

// Reuse evidence shapes, never an E0/E1 evaluation or its deployment status.
export const V1DataSourceSchema = ResearchEloBodySchema.pick({
  identityRevision: true, candidates: true, aliases: true, identities: true, syntheticOnly: true
}).extend({
  request: V1DataRequestSchema,
  code: z.array(z.object({ path: z.string().min(1).max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(2000)
}).strict();
export const V1DataEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('v1-development-dataset-v1'),
  source: V1DataSourceSchema, report: z.unknown(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type V1DataRequest = z.infer<typeof V1DataRequestSchema>;
export type V1DataSource = z.infer<typeof V1DataSourceSchema>;
