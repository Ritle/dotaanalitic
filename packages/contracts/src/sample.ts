import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Count=z.number().int().nonnegative(),Time=z.iso.datetime({precision:3}),Rate=z.number().min(0).max(1);
export const SampleEvidenceSchema=z.object({policyVersion:z.literal('sample-evidence-v1'),nRaw:Count.nullable(),nEff:z.null(),weightPolicyVersion:z.null(),
  band:z.enum(['unknown','empty','under_10','10_to_29','30_or_more']),coldStart:z.boolean().nullable(),smallSample:z.boolean().nullable()}).strict();
export const SmoothingSchema=z.object({status:z.enum(['available','unavailable']),smoothedObservedRate:Rate.nullable(),priorOnly:z.boolean(),
  policyVersion:z.literal('earlier-reference-beta-v1'),validation:z.literal('unvalidated_descriptive'),reasons:z.array(z.string()),
  prior:z.object({alpha:Count,beta:Count,mean:Rate,mass:Count,heroId:CatalogIdSchema,rolePos:z.number().int().min(1).max(5),patchId:CatalogIdSchema,
    beforeAt:Time,matchIds:z.array(CatalogIdSchema),seriesIds:z.array(z.uuid())}).strict().nullable()}).strict();
export const ReferencePoolSchema=z.object({status:z.enum(['ready','unavailable']),reason:z.string().nullable(),beforeAt:Time,
  policyVersion:z.literal('earlier-reference-beta-v1'),scope:z.literal('retrospective_reference'),
  coverage:z.object({candidates:Count.nullable(),eligibleMaps:Count.nullable(),heroObservations:Count.nullable(),confirmedRoles:Count.nullable(),knownPatches:Count.nullable(),verifiedSeries:Count.nullable()}).strict(),
  globalBuckets:z.array(z.object({heroId:CatalogIdSchema,rolePos:z.number().int().min(1).max(5).nullable(),nRaw:Count,wins:Count,winRate:Rate,sampleEvidence:SampleEvidenceSchema}).strict()),
  buckets:z.array(z.object({heroId:CatalogIdSchema,rolePos:z.number().int().min(1).max(5).nullable(),patchId:CatalogIdSchema.nullable(),
    nRaw:Count,wins:Count,winRate:Rate,sampleEvidence:SampleEvidenceSchema}).strict()),
  provenance:z.array(z.object({matchId:CatalogIdSchema,dataRevision:z.string(),startedAt:Time,source:z.string(),syncedAt:Time,sourceFetchedAt:Time.nullable(),
    identityProofIds:z.array(z.string()),roleProofIds:z.array(z.string()),patchProofIds:z.array(z.string()),seriesProofIds:z.array(z.string())}).strict())}).strict();
export type Smoothing=z.infer<typeof SmoothingSchema>;
export type SampleEvidence=z.infer<typeof SampleEvidenceSchema>;
