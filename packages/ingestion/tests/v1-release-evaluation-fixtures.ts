import { releasePlanFixture } from '../../db/tests/v1-release-plan-fixtures.js';
import { prepareV1Data } from '../../db/src/v1-data.js';
import { releaseEvidenceFixture, releaseSha, reseal } from './v1-release-evidence-fixtures.js';
import { freezeV1ReleaseCapture } from '../src/v1-release-evidence.js';
import { evaluateV1ReleaseCapture } from '../src/v1-release-evaluation.js';
export function releaseJournalFixture(tag: string) {
  const original = releasePlanFixture();
  const base: typeof original = JSON.parse(JSON.stringify(original).replaceAll('2026-', '2025-'), (key, v: unknown) => {
    if (key.endsWith('Us') && typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) >= BigInt(Date.parse('2026-01-01')) * 1000n)
      return (BigInt(v) - 365n * 86400000000n).toString();
    return v;
  });
  base.request.events[0]!.eventKey = 'synthetic-' + tag;
  base.development = prepareV1Data(base.development.source);
  base.request.developmentDatasetSha256 = releaseSha(JSON.stringify(base.development));
  base.request.catalogueSha256 = releaseSha(JSON.stringify(base.catalogue));
  const f = releaseEvidenceFixture(base);
  const capture = freezeV1ReleaseCapture(f.plan, f.candidate, f.inventory, f.ledger, f.batches,
    f.plan.evaluateNotBefore, f.files, 'e'.repeat(64), f.code);
  const report = evaluateV1ReleaseCapture(f.plan, f.candidate, capture, f.ledger, f.batches, f.plan.evaluateNotBefore);
  const captureText = JSON.stringify(capture);
  const request = { planFingerprint: f.plan.fingerprint, planSha256: f.files.planSha256,
    captureText, captureSha256: releaseSha(captureText), scorerCode: f.code };
  return { ...f, capture, report, request, score: (scorerCode = f.code) => reseal({ ...report, scorerCode }) };
}
