import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalContextJson } from '../src/temporal.js';
import { freezeResearchElo } from '../src/research-elo.js';
import { verifyResearchExecutionPlan, assertResearchExecutionTime, freezeResearchExecution, evaluateResearchExecution } from '../src/research-execution.js';
import { executionFixture } from './research-execution-fixtures.js';
import { micros } from './research-elo-fixtures.js';
const refreeze = (v: ReturnType<typeof freezeResearchElo>) => {
  const { fingerprint: _fingerprint, ...body } = v; return freezeResearchElo(body);
};

it('rebuilds the plan and rejects altered selection even with a recomputed plan fingerprint', () => {
  const f = executionFixture();
  expect(verifyResearchExecutionPlan(f.plan, f.sources.prior, f.sources.discovery)).toEqual(f.plan);
  const forged = { ...f.plan, warmup: { ...f.plan.warmup, assessments: [] } };
  const { fingerprint: _fingerprint, ...body } = forged;
  forged.fingerprint = createHash('sha256').update(canonicalContextJson(body)).digest('hex');
  expect(() => verifyResearchExecutionPlan(forged, f.sources.prior, f.sources.discovery)).toThrow('execution_plan_replay_mismatch');
});

it('blocks scoring before the boundary even for invalid input, accepts exact boundary, rejects invalid clocks', () => {
  const f = executionFixture();
  expect(() => evaluateResearchExecution(f.plan, null, '2026-11-09T23:59:59.999Z')).toThrow('execution_too_early');
  expect(() => freezeResearchExecution(f.plan, f.snapshot, '2026-11-09T23:59:59.999Z', f.code)).toThrow('execution_too_early');
  expect(() => assertResearchExecutionTime(f.plan, f.now)).not.toThrow();
  expect(() => assertResearchExecutionTime(f.plan, 'invalid')).toThrow('execution_clock_invalid');
});

it('replays deterministically without mutating input and never produces a release gate or per-map probability', () => {
  const f = executionFixture(), before = JSON.stringify(f.snapshot);
  const captured = freezeResearchExecution(f.plan, f.snapshot, f.now, f.code);
  const result = evaluateResearchExecution(f.plan, captured, f.now);
  expect(result).toMatchObject({ releaseGate: 'not_assessed', deployable: false, trainingReady: false, teamAWinProbability: null,
    evaluation: { status: 'research_complete', syntheticOnly: true, summary: { warmupMaps: 9, holdoutMaps: 2, holdoutSeries: 2 } } });
  expect(result).toEqual(evaluateResearchExecution(f.plan, captured, '2026-11-11T00:00:00.000Z'));
  expect(JSON.stringify(f.snapshot)).toBe(before);
  expect(result.evaluation.observations.every(o => !('probability' in o))).toBe(true);
});

it('rejects a changed cutoff, synthetic classification, incomplete warmup, altered start and unexpected warmup', () => {
  const f = executionFixture();
  const reject = (change: (v: typeof f.snapshot) => void, error: string) => {
    const v = structuredClone(f.snapshot); change(v);
    expect(() => freezeResearchExecution(f.plan, refreeze(v), f.now, f.code)).toThrow(error);
  };
  reject(v => { v.request.snapshotAt = '2026-11-11T00:00:00.000Z'; }, 'execution_request_mismatch');
  reject(v => { v.syntheticOnly = false; }, 'execution_synthetic_mismatch');
  reject(v => { v.candidates.shift(); }, 'execution_warmup_missing_or_changed');
  reject(v => { v.candidates[0]!.startedAtUs = micros(f.plan.request.holdoutFromAt); }, 'execution_warmup_missing_or_changed');
  reject(v => { v.candidates.push({ ...v.candidates[0]!, matchId: '999' }); }, 'execution_unregistered_warmup');
});

it('rejects corrupt snapshot/envelope, plan binding, duplicate inventory and future capture', () => {
  const f = executionFixture(), capture = freezeResearchExecution(f.plan, f.snapshot, f.now, f.code);
  expect(() => freezeResearchExecution(f.plan, { ...f.snapshot, identityRevision: '99' }, f.now, f.code)).toThrow('execution_snapshot_fingerprint_mismatch');
  const duplicate = structuredClone(f.snapshot); duplicate.candidates.push(duplicate.candidates[0]!);
  expect(() => freezeResearchExecution(f.plan, refreeze(duplicate), f.now, f.code)).toThrow('execution_duplicate_map');
  expect(() => freezeResearchExecution(f.plan, f.snapshot, f.now, [...f.code, ...f.code])).toThrow('execution_duplicate_code');
  expect(() => evaluateResearchExecution(f.plan, { ...capture, planFingerprint: 'a'.repeat(64) }, f.now)).toThrow('execution_binding_invalid');
  const future = freezeResearchExecution(f.plan, f.snapshot, '2026-11-11T00:00:00.000Z', f.code);
  expect(() => evaluateResearchExecution(f.plan, future, f.now)).toThrow('execution_capture_in_future');
});

it('keeps outside-window siblings so whole-series exclusions cannot be bypassed', () => {
  const f = executionFixture(), target = f.snapshot.candidates.find(m => m.matchId === '201')!;
  const sibling = structuredClone(target); sibling.matchId = '999'; sibling.startedAtUs = micros(f.plan.request.holdoutUntil);
  f.snapshot.candidates.push(sibling);
  const captured = freezeResearchExecution(f.plan, refreeze(f.snapshot), f.now, f.code);
  const result = evaluateResearchExecution(f.plan, captured, f.now);
  expect(result.evaluation.assessments.find(a => a.matchId === '201')!.reasons).toContain('SERIES_OUTSIDE_WINDOW');
  expect(result.evaluation.summary.scoredMaps).toBe(1);
});

it('reports null metrics for an empty eligible holdout and does not extend the window', () => {
  const f = executionFixture(); f.snapshot.candidates = f.snapshot.candidates.filter(m => BigInt(m.startedAtUs) < BigInt(micros(f.plan.request.holdoutFromAt)));
  const report = evaluateResearchExecution(f.plan, freezeResearchExecution(f.plan, refreeze(f.snapshot), f.now, f.code), f.now);
  expect(report.evaluation).toMatchObject({ status: 'unavailable', reason: 'NO_HOLDOUT_MAPS', metrics: null });
  expect(report.evaluation.request.toAt).toBe(f.plan.request.holdoutUntil);
});
