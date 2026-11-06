import { z } from 'zod';
import { V1ReleasePlanRequestSchema } from './v1-release-plan.js';
const Time = z.iso.datetime({ precision: 3 }), Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Id = V1ReleasePlanRequestSchema.shape.events.element.shape.leagueId;
const File = z.object({ path: z.string().min(1).max(1024), sha256: Sha }).strict();
const ids = z.array(Id).max(100000).refine(xs => new Set(xs).size === xs.length);
export const V1RetestCollectionPolicySchema = z.object({
  historyWarmupFromAt: Time, historyRequestBeforeAt: Time,
  historyWindowDays: z.literal(730), historyMaxMapsPerAccount: z.literal(10),
  maxMaps: z.literal(5000), maxDetailAttemptsPerMap: z.literal(3), maxRequestsPerRun: z.literal(50),
  collectionDeadline: Time,
  stop: z.literal('all_work_terminal_or_deadline'),
  evaluation: z.literal('one_after_terminal_collection_and_verified_freeze'),
  missingTargets: z.literal('retain_in_coverage_denominator'),
  historySelection: z.literal('latest_completed_before_global_cutoff_numeric_account_groups_of_five'),
  perMapFeatureCutoff: z.literal('completed_at_strictly_before_target_start'),
  extendAfterScoring: z.literal(false), automaticActivation: z.literal(false)
}).strict();
export const V1RetestRequestSchema = z.object({
  schemaVersion: z.literal(2), protocolKey: z.string().regex(/^[a-z0-9-]{3,100}$/),
  proposalSha256: Sha, collection: V1RetestCollectionPolicySchema,
  priorAttempt: z.literal('preserve_first_fail_no_best_result_selection'),
  exposureAcknowledgement: z.literal('bounded_local_audit_not_global_blindness_proof')
}).strict();
export const V1RetestFilesSchema = z.object({
  schemaVersion: z.literal(2), request: File, proposal: File, intent: File, catalogue: File,
  fileExposure: File, databaseExposure: File, captureIndex: File, metadataReview: File,
  accessReview: File,
  previous: z.object({ inputs: File, protocol: File, freeze: File, started: File, report: File, registry: File }).strict()
}).strict();
export const V1RetestIntentSchema = z.looseObject({
  format: z.literal('v1-retest-proposal-intent-v1'), createdAt: Time,
  status: z.literal('proposal_not_registered_release_protocol'),
  priorReport: z.object({ path: File.shape.path, sha256: Sha, decision: z.literal('failed') }).strict(),
  events: z.array(z.object({ leagueId: Id, name: z.string().min(1).max(512), fromAt: Time, until: Time,
    sourceUrl: z.url().refine(s => new URL(s).protocol === 'https:') }).strict()).min(1).max(7),
  warmupFromAt: Time, eventCutoffAt: Time,
  wholeEventExclusions: z.array(z.object({ leagueId: Id, reason: z.string().min(1).max(1000) }).strict()).max(30),
  limits: z.object({ maxDiscoveryHttpRequests: z.literal(14), maxUniqueMaps: z.literal(5000),
    maxDetailAttemptsPerMap: z.literal(3), proposedCollectionDeadline: Time }).strict(),
  unchangedModel: z.object({ initialRating: z.literal(1500), k: z.literal(32), scale: z.literal(400),
    minPriorMapsPerPlayer: z.literal(5), calibrator: z.literal(false) }).strict(),
  qualityPolicySha256: Sha, disclosures: z.array(z.string().min(1).max(2000)).min(1).max(20),
  freshEvaluationPerformed: z.literal(false), automaticActivation: z.literal(false)
}).refine(r => new Set(r.events.map(e => e.leagueId)).size === r.events.length &&
  r.events.every(e => r.warmupFromAt < e.fromAt && e.fromAt < e.until && e.until <= r.eventCutoffAt &&
    !/qualif|division\s*(?:2|ii)\b|practice/i.test(e.name) && !r.wholeEventExclusions.some(x => x.leagueId === e.leagueId)),
{ message: 'invalid_retest_scope' });
export const V1RetestProposalSchema = z.looseObject({
  format: z.literal('v1-retest-proposal-checkpoint-v1'), checkedAt: Time,
  status: z.literal('metadata_feasible_registration_pending'), protocolRegistered: z.literal(false),
  freshModelEvaluationPerformed: z.literal(false), deployable: z.literal(false), teamAWinProbability: z.null(),
  intent: File, catalogue: File, pilotReport: File, pilotDecision: z.literal('failed'), qualityPolicySha256: Sha,
  exposure: z.looseObject({ fileManifest: File, databaseSnapshot: File, capturedAt: Time, fileCount: z.number().int().nonnegative() }),
  sourceCapture: File, metadataReview: File,
  proposal: z.looseObject({ eventCount: z.number().int().min(1).max(7),
    ...V1RetestCollectionPolicySchema.pick({ historyWarmupFromAt: true, historyRequestBeforeAt: true, historyWindowDays: true,
      historyMaxMapsPerAccount: true, maxMaps: true, maxDetailAttemptsPerMap: true, maxRequestsPerRun: true, collectionDeadline: true }).shape }),
  summary: z.unknown(), syntheticOnly: z.boolean().optional()
});
export const V1RetestFileExposureSchema = z.looseObject({
  capturedAt: Time, files: z.array(File.extend({ bytes: z.number().int().nonnegative() })).max(20000),
  potentialMapIds: ids, opendotaSeriesIds: ids
});
export const V1RetestDatabaseExposureSchema = z.looseObject({
  capturedAt: Time, maps: z.array(z.looseObject({ matchId: Id, leagueId: Id.nullable(),
    provider: z.string().nullable(), providerSeriesId: Id.nullable() })).max(100000)
});
export const V1RetestCaptureIndexSchema = z.looseObject({ captures: z.array(File).min(1).max(7), completedAt: Time });
export const V1RetestAccessReviewSchema = z.object({
  schemaVersion: z.literal(1), proposalSha256: Sha, checkedAt: Time,
  basis: z.literal('bounded_local_file_and_database_review'),
  newOutcomeOrModelAccess: z.literal(false),
  additionalExposedMatchIds: ids.max(0), additionalExposedSeriesIds: ids.max(0),
  evidence: File, limitations: z.array(z.string().min(1).max(1000)).min(1).max(10)
}).strict();
