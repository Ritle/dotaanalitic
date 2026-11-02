import { z } from 'zod';
import { V1CandidateCodeSchema } from './v1-candidate.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime({ precision: 3 });
export const V1FreezeRuntimeSchema = z.object({ node: z.string().regex(/^v\d+\.\d+\.\d+$/).refine(s => Number(s.slice(1).split('.')[0]) >= 22),
  platform: z.enum(['win32', 'linux', 'darwin']), arch: z.string().min(1).max(32),
  nodeBinarySha256: Sha }).strict();
export const V1ExecutableFreezeBodySchema = z.object({ schemaVersion: z.literal(1),
  format: z.literal('v1-release-executable-freeze-v1'), registeredAt: Time,
  planSha256: Sha, planFingerprint: Sha, candidateSha256: Sha, candidateFingerprint: Sha,
  qualityPolicySha256: Sha, testFromAt: Time, evaluateNotBefore: Time,
  syntheticOnly: z.boolean(), code: V1CandidateCodeSchema, runtime: V1FreezeRuntimeSchema,
  complete: z.literal(true), activation: z.literal('separate_gate_required')
}).strict();
export const V1ExecutableFreezeSchema = V1ExecutableFreezeBodySchema.extend({ fingerprint: Sha });
export type V1ExecutableFreeze = z.infer<typeof V1ExecutableFreezeSchema>;
