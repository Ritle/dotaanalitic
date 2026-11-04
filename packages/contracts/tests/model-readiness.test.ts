import { expect, test } from 'vitest';
import { V1ModelReadinessSchema } from '../src/v1-model-readiness';
const base = { stage: 'pre_match', checkedAt: '2026-11-03T17:00:00.000Z', teamAWinProbability: null };
const id = '00000000-0000-4000-8000-000000000001';
test('accepts registry-only states with explicit null probability and bound evidence', () => {
  for (const state of [{ status: 'unavailable', reason: 'NO_ACTIVE_MODEL', modelId: null, reportSha256: null },
    { status: 'unavailable', reason: 'ACTIVE_MODEL_EVIDENCE_INVALID', modelId: id, reportSha256: null },
    { status: 'model_eligible', reason: null, modelId: id, reportSha256: 'a'.repeat(64) }])
    expect(V1ModelReadinessSchema.safeParse({ ...base, ...state }).success).toBe(true);
});
test('rejects invented probability, unknown stage/reason and leaked artifact fields', () => {
  const valid = { ...base, status: 'unavailable', reason: 'NO_ACTIVE_MODEL', modelId: null, reportSha256: null };
  for (const extra of [{ teamAWinProbability: 0.5 }, { stage: 'post_draft' }, { reason: 'UNKNOWN' }, { artifact: 'private' }])
    expect(V1ModelReadinessSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
});
test('rejects inconsistent model and release evidence instead of declaring eligibility', () => {
  for (const state of [{ status: 'unavailable', reason: 'NO_ACTIVE_MODEL', modelId: id, reportSha256: null },
    { status: 'unavailable', reason: 'ACTIVE_MODEL_EVIDENCE_INVALID', modelId: null, reportSha256: null },
    { status: 'model_eligible', reason: null, modelId: id, reportSha256: null }])
    expect(V1ModelReadinessSchema.safeParse({ ...base, ...state }).success).toBe(false);
});
