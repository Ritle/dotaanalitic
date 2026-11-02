import { createHash } from 'node:crypto';
import { ResearchEloExportSchema, ResearchExecutionBodySchema, ResearchExecutionSchema } from '@dota/contracts';
import { canonicalContextJson } from './temporal.js';
import { planResearchElo } from './research-plan.js';
import { evaluateResearchElo } from './research-elo.js';

type Plan = ReturnType<typeof planResearchElo>;
const hash = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');
const micros = (time: string) => BigInt(Date.parse(time)) * 1000n;

/** Rebuild from pinned source files; a self-consistent edited plan is insufficient. */
export function verifyResearchExecutionPlan(saved: unknown, prior: unknown, discovery: unknown) {
  if (!saved || typeof saved !== 'object' || !('request' in saved) || !('registeredAt' in saved) ||
    typeof saved.registeredAt !== 'string') throw Error('execution_plan_invalid');
  const plan = planResearchElo(saved.request, prior, discovery, saved.registeredAt);
  if (canonicalContextJson(saved) !== canonicalContextJson(plan)) throw Error('execution_plan_replay_mismatch');
  return plan;
}

export function researchExecutionRequest(plan: Plan) {
  return { schemaVersion: 1 as const, cohort: plan.cohort, fromAt: plan.request.warmupFromAt,
    holdoutFromAt: plan.request.holdoutFromAt, toAt: plan.request.holdoutUntil,
    snapshotAt: plan.request.evaluationNotBefore, maxMaps: plan.request.maxExportMaps,
    evaluationPolicy: 'event-time-prequential-series-v1' as const };
}

export function assertResearchExecutionTime(plan: Plan, now: string) {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw Error('execution_clock_invalid');
  if (now < plan.request.evaluationNotBefore) throw Error('execution_too_early');
}

function validateSnapshot(plan: Plan, input: unknown) {
  const parsed = ResearchEloExportSchema.parse(input), { fingerprint, ...body } = parsed;
  if (hash(body) !== fingerprint) throw Error('execution_snapshot_fingerprint_mismatch');
  if (canonicalContextJson(parsed.request) !== canonicalContextJson(researchExecutionRequest(plan))) throw Error('execution_request_mismatch');
  if (canonicalContextJson(parsed.policy) !== canonicalContextJson(plan.eloPolicy)) throw Error('execution_policy_mismatch');
  if (parsed.syntheticOnly !== plan.syntheticOnly) throw Error('execution_synthetic_mismatch');
  if (parsed.candidates.length > plan.request.maxExportMaps || parsed.aliases.length > plan.request.maxExportMaps) throw Error('execution_inventory_limit');
  const byId = new Map(parsed.candidates.map(m => [m.matchId, m]));
  if (byId.size !== parsed.candidates.length) throw Error('execution_duplicate_map');
  const warmup = new Map(plan.reviewedMaps.map(m => [m.matchId, m.startedAtUs]));
  for (const row of plan.warmup.assessments.filter(m => m.action === 'fetch_and_verify')) warmup.set(row.matchId, micros(row.startedAt).toString());
  for (const [id, time] of warmup) {
    // Missing imports must be made explicit, never silently improve coverage by dropping candidates.
    const map = byId.get(id);
    if (!map || map.startedAtUs !== time) throw Error('execution_warmup_missing_or_changed');
  }
  for (const map of parsed.candidates) {
    const start = BigInt(map.startedAtUs);
    if (start >= micros(plan.request.warmupFromAt) && start < micros(plan.request.holdoutFromAt) && !warmup.has(map.matchId)) {
      // Conservative stop: do not silently alter the registered history or discard known series siblings.
      throw Error('execution_unregistered_warmup');
    }
  }
  // All local inventory, including outside-window siblings, is passed unmodified to the E0 series guards.
  return parsed;
}

export function freezeResearchExecution(plan: Plan, snapshot: unknown, capturedAt: string, executionCode: unknown) {
  assertResearchExecutionTime(plan, capturedAt);
  const body = ResearchExecutionBodySchema.parse({ schemaVersion: 1, format: 'research-elo-execution-v1',
    planFingerprint: plan.fingerprint, capturedAt, inventoryScope: 'all_local_maps_remote_completeness_unknown',
    snapshot: validateSnapshot(plan, snapshot), executionCode, trainingReady: false, deployable: false });
  if (new Set(body.executionCode.map(c => c.path)).size !== body.executionCode.length) throw Error('execution_duplicate_code');
  return { ...body, fingerprint: hash(body) };
}

export function evaluateResearchExecution(plan: Plan, input: unknown, now: string) {
  assertResearchExecutionTime(plan, now); // No snapshot parsing or scoring before the boundary.
  const parsed = ResearchExecutionSchema.parse(input), { fingerprint, ...body } = parsed;
  if (hash(body) !== fingerprint || body.planFingerprint !== plan.fingerprint) throw Error('execution_binding_invalid');
  if (body.capturedAt > now) throw Error('execution_capture_in_future');
  const rebuilt = freezeResearchExecution(plan, body.snapshot, body.capturedAt, body.executionCode);
  if (canonicalContextJson(parsed) !== canonicalContextJson(rebuilt)) throw Error('execution_replay_mismatch');
  const evaluation = evaluateResearchElo(body.snapshot);
  const report = { schemaVersion: 1, format: 'research-elo-guarded-report-v1',
    planFingerprint: plan.fingerprint, executionFingerprint: fingerprint,
    inventoryScope: body.inventoryScope, evaluation,
    releaseGate: 'not_assessed', trainingReady: false, deployable: false, teamAWinProbability: null };
  return { ...report, fingerprint: hash(report) };
}
