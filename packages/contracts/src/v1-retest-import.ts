import {z} from 'zod';
import {HistoricalImportConfigSchema} from './v1-historical-import.js';
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const RetestImportConfigSchema=HistoricalImportConfigSchema.extend({schemaVersion:z.literal(2)}).strict();
export const RetestImportManifestSchema=z.object({schemaVersion:z.literal(2),format:z.literal('retest-import-sources-v2'),
 collectionSha256:Sha,closureSha256:Sha,configSha256:Sha,protocolFingerprint:Sha,stateFingerprint:Sha,
 files:z.array(z.object({directory:z.enum(['admissions','outcomes','cached','runs','recoveries']),
  name:z.string().regex(/^[a-z0-9.-]+\.json$/).max(100),sha256:Sha}).strict()).max(60000)
  .refine(rows=>new Set(rows.map(r=>r.directory+'/'+r.name)).size===rows.length),fingerprint:Sha
}).strict();
