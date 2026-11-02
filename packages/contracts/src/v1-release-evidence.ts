import { z } from 'zod';
import { V1DataSourceSchema } from './v1-data.js';
import { ResearchEvidenceFilesSchema } from './research-evidence.js';
import { V1CandidateCodeSchema } from './v1-candidate.js';
import { CanonicalPlayerIdSchema as Id } from './identity.js';
import { V1ExecutableFreezeSchema } from './v1-executable-freeze.js';
const Time = z.iso.datetime({ precision: 3 });
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Path = z.string().min(1).max(1024);
export const V1InventoryWindowSchema = z.object({ fromAt: Time, toAt: Time, snapshotAt: Time,
  maxMaps: z.number().int().min(1).max(5000) }).strict()
  .refine(r => r.fromAt < r.toAt && r.toAt <= r.snapshotAt, { message: 'invalid_release_inventory_window' });
export const V1ReleaseInventoryBodySchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('v1-release-inventory-v1'),
  source: V1DataSourceSchema.omit({ request: true }).extend({ request: V1InventoryWindowSchema }).strict(),
  metadata: z.array(z.object({ matchId: Id, leagueId: Id.nullable(), radiantProviderTeamId: Id.nullable(),
    direProviderTeamId: Id.nullable() }).strict()).max(5000),
  inventoryScope: z.literal('all_local_maps_remote_completeness_unknown')
}).strict();
export const V1ReleaseInventorySchema = V1ReleaseInventoryBodySchema.extend({ fingerprint: Sha });
export const V1ReleaseFilesSchema = z.object({ planPath: Path, planSha256: Sha, cataloguePath: Path,
  developmentPath: Path, candidatePath: Path, candidateSha256: Sha, evidence: ResearchEvidenceFilesSchema,
  freeze: z.object({ path: Path, sha256: Sha }).strict().optional() }).strict();
export const V1ReleaseCaptureBodySchema = z.object({ schemaVersion: z.literal(1),
  format: z.literal('v1-release-source-capture-v1'), capturedAt: Time, planFingerprint: Sha, candidateFingerprint: Sha,
  files: V1ReleaseFilesSchema, filesSha256: Sha, inventory: V1ReleaseInventorySchema,
  bindingFingerprint: Sha, executionCode: V1CandidateCodeSchema,
  evaluation: z.literal('not_performed'), executableFreezeComplete: z.boolean(),
  executableFreeze: V1ExecutableFreezeSchema.optional(),
  releaseGatePassed: z.literal(false), deployable: z.literal(false), teamAWinProbability: z.null()
}).strict();
export const V1ReleaseCaptureSchema = V1ReleaseCaptureBodySchema.extend({ fingerprint: Sha });
export type V1ReleaseInventory = z.infer<typeof V1ReleaseInventorySchema>;
