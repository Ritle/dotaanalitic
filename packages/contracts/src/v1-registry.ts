import { z } from 'zod';
import { V1ReleasePlanRequestSchema } from './v1-release-plan.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime({ precision: 3 });
export const V1RegistryArtifactSchema = z.object({
  planText: z.string().max(4194304), planSha256: Sha,
  candidateText: z.string().max(4194304), candidateSha256: Sha,
  freezeText: z.string().max(4194304), freezeSha256: Sha,
}).strict();
export const V1RegistryPlanSchema = z.object({ format: z.literal('v1-release-plan-v1'), fingerprint: Sha,
  registeredAt: Time, testFromAt: Time, evaluateNotBefore: Time, syntheticOnly: z.boolean(),
  request: V1ReleasePlanRequestSchema, qualityPolicy: z.unknown(), developmentFingerprint: Sha,
}).passthrough();
export const V1RegistryTransitionSchema = z.object({ requestId: z.uuid(),
  action: z.enum(['promote', 'rollback', 'deactivate']), modelId: z.uuid().nullable(),
  expectedCurrentId: z.uuid().nullable(), reason: z.string().trim().min(10).max(1000),
  release: z.object({ planFingerprint: Sha, revision: z.number().int().min(1).max(2147483647), reportSha256: Sha }).strict().nullable(),
}).strict().refine(r => r.action === 'deactivate' ? r.modelId === null && r.release === null && r.expectedCurrentId !== null :
  r.modelId !== null && r.modelId !== r.expectedCurrentId && r.release !== null, { message: 'invalid_registry_transition' });
export type V1RegistryArtifact = z.infer<typeof V1RegistryArtifactSchema>;
export type V1RegistryTransition = z.infer<typeof V1RegistryTransitionSchema>;
