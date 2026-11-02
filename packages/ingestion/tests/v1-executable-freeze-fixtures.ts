import { releaseJournalFixture } from './v1-release-evaluation-fixtures.js';
import { releaseSha } from './v1-release-evidence-fixtures.js';
import { registerV1ExecutableFreeze } from '../../db/src/v1-executable-freeze.js';
import { freezeV1ReleaseCapture } from '../src/v1-release-evidence.js';
import { evaluateV1ReleaseCapture } from '../src/v1-release-evaluation.js';
export function frozenReleaseFixture(tag: string) {
  const f = releaseJournalFixture(tag), runtime = { node: 'v22.15.0', platform: 'win32', arch: 'x64', nodeBinarySha256: 'b'.repeat(64) };
  const freeze = registerV1ExecutableFreeze(f.plan, f.candidate, f.files.planSha256, f.files.candidateSha256, f.code, runtime,
    new Date(Date.parse(f.candidate.registration.kernelRegisteredAt) + 1000).toISOString());
  const files = { ...f.files, freeze: { path: 'synthetic-freeze.json', sha256: releaseSha(JSON.stringify(freeze)) } };
  const capture = freezeV1ReleaseCapture(f.plan, f.candidate, f.inventory, f.ledger, f.batches,
    f.plan.evaluateNotBefore, files, 'e'.repeat(64), f.code, freeze);
  const report = evaluateV1ReleaseCapture(f.plan, f.candidate, capture, f.ledger, f.batches, f.plan.evaluateNotBefore);
  const captureText = JSON.stringify(capture);
  return { ...f, files, freeze, runtime, capture, report,
    request: { ...f.request, captureText, captureSha256: releaseSha(captureText) }, score: () => report };
}
