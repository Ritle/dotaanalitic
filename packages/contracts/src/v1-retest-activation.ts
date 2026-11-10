import { z } from 'zod';
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const RetestTransitionSchema = z.object({
  requestId: z.uuid(), action: z.enum(['promote', 'rollback', 'deactivate']),
  modelId: z.uuid().nullable(), expectedCurrentId: z.uuid().nullable(),
  reason: z.string().trim().min(10).max(1000),
  evidence: z.object({ protocolFingerprint: Sha, freezeSha256: Sha, reportSha256: Sha }).strict().nullable()
}).strict().refine(r => r.action === 'deactivate'
  ? r.modelId === null && r.evidence === null && r.expectedCurrentId !== null
  : r.modelId !== null && r.modelId !== r.expectedCurrentId && r.evidence !== null);
