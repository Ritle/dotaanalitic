import {z} from 'zod';
const File=z.object({path:z.string().min(1).max(1024),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const HistoricalImportConfigSchema=z.object({schemaVersion:z.literal(1),
 collection:z.object({directory:z.string().min(1).max(1024),sha256:File.shape.sha256}).strict(),
 sourceManifest:File,heroes:File,registry:File,
 profiles:z.array(File.extend({accountId:z.string().regex(/^[1-9]\d{0,9}$/).refine(v=>BigInt(v)<4294967295n)})).max(500)
  .refine(rows=>new Set(rows.map(r=>r.accountId)).size===rows.length)
}).strict();
