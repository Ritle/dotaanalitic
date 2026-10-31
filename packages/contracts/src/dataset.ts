import { z } from 'zod';
const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(id => BigInt(id) <= 9223372036854775807n);
const Revision = z.string().trim().min(1).max(512);
const Metadata = z.record(z.string(), z.json());
export const DatasetIdSchema = z.uuid();
const reserved = new Set(['radiant_win','team_a_won','winner','label','outcome','duration','duration_seconds','kills','gpm',
  'prediction','probability','prediction_run_id']);
export const DatasetFeaturesSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,95}$/), z.number().finite().nullable())
  .refine(features => Object.keys(features).every(key => !reserved.has(key)), { message: 'Labels and current-map outcomes cannot be features' });
export const DatasetManifestSchema = z.object({
  stage: z.enum(['pre_match','post_draft']), featureSchemaVersion: Revision,
  labelPolicyVersion: z.literal('verified-map-v1'), cutoffPolicyVersion: Revision,
  patchRegistryRevision: Revision, dataRevision: Revision, codeRevision: Revision,
  splitPolicy: Metadata, sourceManifest: Metadata
}).strict();
/** Internal persistence contract, not a public endpoint or a feature eligibility claim. */
export const DatasetMapInputSchema = z.object({
  datasetId: z.uuid(), matchId: Id, outcomeReceiptId: Id, teamAId: Id, teamBId: Id,
  cutoffAt: z.iso.datetime({ precision: 3 }), split: z.enum(['train','calibration','validation','test']),
  labelVerifiedAt: z.iso.datetime({ precision: 3 }).optional(),
  features: DatasetFeaturesSchema
}).strict().refine(row => row.teamAId !== row.teamBId);
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;
export type DatasetMapInput = z.infer<typeof DatasetMapInputSchema>;
