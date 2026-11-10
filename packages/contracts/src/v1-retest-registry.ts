import { z } from 'zod';
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime({ precision: 3 });
const bytes = (max: number) => z.object({ text: z.string().min(2).max(max), sha256: Sha }).strict();
export const RETEST_REGISTRY_LIMITS = { capsule: 268435456, freeze: 4194304, started: 65536, report: 134217728, binding: 4194304 } as const;
export const RetestRegistryEvidenceSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('v1-retest-registry-evidence-v1'),
  capsule: bytes(RETEST_REGISTRY_LIMITS.capsule), freeze: bytes(RETEST_REGISTRY_LIMITS.freeze),
  started: bytes(RETEST_REGISTRY_LIMITS.started), report: bytes(RETEST_REGISTRY_LIMITS.report), binding: bytes(RETEST_REGISTRY_LIMITS.binding)
}).strict();
export const RetestRegistryMetadataSchema = z.object({
  schemaVersion: z.literal(1), stage: z.literal('pre_match'), algorithm: z.literal('fixed_player_mean_elo'),
  featureSchemaVersion: z.literal('player-mean-elo-completed-strict-v1'),
  evaluationBasis: z.literal('conditional_retrospective_unexposed_series'), qualityDecision: z.literal('passed'),
  protocolFingerprint: Sha, datasetFingerprint: Sha, candidateFingerprint: Sha, freezeFingerprint: Sha,
  reportFingerprint: Sha, qualityPolicySha256: Sha, previousReportSha256: Sha, scorerCodeFingerprint: Sha,
  registeredAt: Time, firstScoringAt: Time, warmupFromAt: Time, testFromAt: Time, testUntil: Time,
  scoredMaps: z.number().int().min(1), scoredSeries: z.number().int().min(1),
  metrics: z.object({ n: z.number().int().min(1), brier: z.number().min(0).max(1), logLoss: z.number().min(0), ece: z.number().min(0).max(1) }).passthrough(),
  runtime: z.object({ node: z.string(), platform: z.string(), arch: z.string(), nodeBinarySha256: Sha }).strict(),
  syntheticOnly: z.literal(false), isActive: z.literal(false), deployable: z.literal(false)
}).strict().refine(m => m.warmupFromAt < m.testFromAt && m.testFromAt < m.testUntil &&
  m.registeredAt <= m.firstScoringAt && m.metrics.n === m.scoredMaps);
export type RetestRegistryEvidence = z.infer<typeof RetestRegistryEvidenceSchema>;
export type RetestRegistryMetadata = z.infer<typeof RetestRegistryMetadataSchema>;
