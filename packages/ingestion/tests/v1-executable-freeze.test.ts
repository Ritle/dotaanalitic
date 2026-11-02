import { expect, it } from 'vitest';
import { V1FrozenReleaseReportSchema } from '@dota/contracts';
import { registerV1ExecutableFreeze, verifyV1ExecutableFreeze } from '../../db/src/v1-executable-freeze.js';
import { verifyV1ReleaseCapture } from '../src/v1-release-evidence.js';
import { frozenReleaseFixture } from './v1-executable-freeze-fixtures.js';
import { reseal } from './v1-release-evidence-fixtures.js';
it('registers a complete pre-test manifest and binds capture/report without activating synthetic or insufficient evidence', () => {
  const f = frozenReleaseFixture('complete');
  expect(verifyV1ExecutableFreeze(f.freeze, f.plan, f.candidate, f.files.planSha256, f.files.candidateSha256, f.code, f.runtime)).toEqual(f.freeze);
  expect(f.capture).toMatchObject({ executableFreezeComplete: true, executableFreeze: { fingerprint: f.freeze.fingerprint } });
  expect(f.report).toMatchObject({ format: 'v1-release-evaluation-v2', freezeFingerprint: f.freeze.fingerprint,
    executableFreezeComplete: true, releaseGatePassed: false, deployable: false,
    evaluation: { qualityDecision: 'insufficient_evidence', syntheticOnly: true } });
});
it('rejects registration at/after test start and before the kernel registration', () => {
  const f = frozenReleaseFixture('clock');
  for (const at of [f.plan.testFromAt, f.plan.evaluateNotBefore, f.plan.registeredAt])
    expect(() => registerV1ExecutableFreeze(f.plan, f.candidate, f.files.planSha256, f.files.candidateSha256, f.code, f.runtime, at))
      .toThrow('freeze_registration_window');
});
it('rejects code/runtime/plan/candidate substitutions even with self-consistent fingerprints', () => {
  const f = frozenReleaseFixture('tamper');
  const verify = (input: unknown, runtime: unknown = f.runtime) => verifyV1ExecutableFreeze(input, f.plan, f.candidate,
    f.files.planSha256, f.files.candidateSha256, f.code, runtime);
  for (const patch of [{ candidateSha256: '0'.repeat(64) }, { planFingerprint: '0'.repeat(64) },
    { code: [{ ...f.code[0]!, sha256: '0'.repeat(64) }] }]) expect(() => verify(reseal({ ...f.freeze, ...patch }))).toThrow();
  expect(() => verify(f.freeze, { ...f.runtime, nodeBinarySha256: '0'.repeat(64) })).toThrow('freeze_replay_mismatch');
  expect(() => registerV1ExecutableFreeze(f.plan, f.candidate, f.files.planSha256, f.files.candidateSha256,
    [{ path: 'missing-kernel.js', sha256: '0'.repeat(64) }], f.runtime, f.freeze.registeredAt)).toThrow('freeze_kernel_code_missing');
});
it('rejects capture freeze downgrade and substituted embedded manifests', () => {
  const f = frozenReleaseFixture('capture');
  const verify = (capture: unknown) => verifyV1ReleaseCapture(f.plan, f.candidate, capture, f.ledger, f.batches, f.plan.evaluateNotBefore);
  expect(() => verify(reseal({ ...f.capture, executableFreezeComplete: false }))).toThrow('freeze_capture_binding');
  expect(() => verify(reseal({ ...f.capture, executableFreeze: reseal({ ...f.freeze, candidateFingerprint: '0'.repeat(64) }) }))).toThrow();
});
it('release decision requires completed, passing, non-synthetic evaluation; activation remains separate', () => {
  const f = frozenReleaseFixture('decision');
  // Contract truth table only: no synthetic maps are relabelled as production input or persisted.
  for (const qualityDecision of ['passed', 'failed', 'insufficient_evidence'] as const)
    for (const syntheticOnly of [true, false]) {
      const passed = qualityDecision === 'passed' && !syntheticOnly;
      const body = { ...f.report, evaluation: { ...f.report.evaluation, status: 'evaluation_complete', qualityDecision, syntheticOnly },
        releaseGatePassed: passed };
      expect(V1FrozenReleaseReportSchema.parse(body).deployable).toBe(false);
      expect(() => V1FrozenReleaseReportSchema.parse({ ...body, releaseGatePassed: !passed })).toThrow();
    }
  expect(() => V1FrozenReleaseReportSchema.parse({ ...f.report, deployable: true })).toThrow();
});
