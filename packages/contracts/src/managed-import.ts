import { z } from 'zod';
const Id = z.string().regex(/^[1-9]\d{0,18}$/);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ManagedImportResultSchema = z.union([
  z.object({ matchId: Id, receiptId: Id, status: z.enum(['accepted', 'partial', 'conflict', 'quarantined']),
    duplicate: z.boolean(), dataRevision: z.string().regex(/^(?:0|[1-9]\d{0,18})$/).nullable() }).strict(),
  z.object({ matchId: Id, status: z.enum(['not_importable', 'import_failed']),
    reasons: z.array(z.string().min(1).max(160)).min(1).max(100) }).strict()
]);
export const ManagedImportManifestSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('evaluation-detail-import-v1'),
  unionSha256: Sha, captureSha256: Sha, completedAt: z.iso.datetime({ precision: 3 }),
  results: z.array(ManagedImportResultSchema).max(50),
  code: z.array(z.object({ path: z.string().min(1).max(512), sha256: Sha }).strict()).min(1).max(2000),
  providerRequests: z.literal(0), modelWrites: z.literal(0), metrics: z.null(), deployable: z.literal(false), fingerprint: Sha
}).strict();
