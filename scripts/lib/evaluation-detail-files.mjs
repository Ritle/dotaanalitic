import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { sha, bounded } from './evaluation-discovery-files.mjs';
import { canonicalContextJson } from '../../packages/db/dist/index.js';
import { validateEvaluationDetails } from '../../packages/ingestion/dist/index.js';
export async function loadCapture(ledger, unionSha, directory, expectedSha) {
  const root = resolve(directory), { data: manifest } = await bounded(join(root, 'manifest.json'), 33554432, expectedSha);
  const { fingerprint, ...body } = manifest;
  if (manifest.format !== 'evaluation-details-capture-v1' || sha(canonicalContextJson(body)) !== fingerprint ||
    manifest.unionSha256 !== unionSha || manifest.discoveryFingerprint !== ledger.fingerprint ||
    !Array.isArray(manifest.receipts) || manifest.receipts.length > 52) throw Error('detail_capture_binding_invalid');
  await bounded(join(root, 'request.json'), 65536, manifest.request.sha256);
  const entries = [];
  for (const [i, ref] of manifest.receipts.entries()) {
    if (ref.path !== `receipt-${String(i).padStart(3, '0')}.json` || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')) throw Error('detail_capture_receipt_invalid');
    entries.push((await bounded(join(root, ref.path), 16777216, ref.sha256)).data);
  }
  const validated = validateEvaluationDetails(ledger, entries, manifest.assessment.selection.batchIndex,
    manifest.assessment.startedAt, manifest.assessment.completedAt);
  if (canonicalContextJson(validated.report) !== canonicalContextJson(manifest.assessment)) throw Error('detail_assessment_replay_mismatch');
  const allowed = new Set(['request.json', 'manifest.json', ...manifest.receipts.map(r => r.path)]);
  if ((await readdir(root)).some(n => !allowed.has(n))) throw Error('detail_unmanifested_receipt');
  return validated;
}
