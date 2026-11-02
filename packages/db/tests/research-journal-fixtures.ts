import { createHash } from 'node:crypto';
import { executionFixture } from './research-execution-fixtures.js';
import { planResearchElo } from '../src/research-plan.js';
import { freezeResearchElo } from '../src/research-elo.js';
import { canonicalContextJson } from '../src/temporal.js';
import { evidenceFixture } from '../../ingestion/tests/research-evidence-fixtures.js';
import { freezeEvidenceResearchExecution, evaluateEvidenceResearchExecution } from '../../ingestion/src/research-evidence.js';
export const journalSha = (s: string) => createHash('sha256').update(s).digest('hex');
export const sealJournal = <T extends object>(value: T) => {
  const { fingerprint: _old, ...body } = value as T & { fingerprint?: string };
  return { ...body, fingerprint: journalSha(canonicalContextJson(body)) };
};
export function researchJournalFixture(tag: string) {
  const original = executionFixture();
  const base: typeof original = JSON.parse(JSON.stringify(original).replaceAll('2026-', '2025-'), (key, value: unknown) => {
    if (key.endsWith('Us') && typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) >= BigInt(Date.parse('2026-01-01')) * 1000n)
      return (BigInt(value) - 365n * 86400000000n).toString();
    return value;
  });
  const { fingerprint: _old, ...prior } = base.sources.prior; base.sources.prior = freezeResearchElo(prior);
  // Synthetic per-test namespaces; only the end-to-end CLI fixture verifies real file hashes.
  base.sources.request.discoverySha256 = journalSha('synthetic-journal:' + tag);
  base.plan = planResearchElo(base.sources.request, base.sources.prior, base.sources.discovery, base.plan.registeredAt);
  const f = evidenceFixture(['201', '202'], false, base);
  const capture = freezeEvidenceResearchExecution(f.plan, f.snapshot, f.now, f.code, f.files, f.ledger, f.batches);
  const captureText = JSON.stringify(capture), report = evaluateEvidenceResearchExecution(f.plan, capture, f.ledger, f.batches, f.now);
  const request = { planSha256: journalSha('synthetic-plan:' + tag), planFingerprint: f.plan.fingerprint,
    captureText, captureSha256: journalSha(captureText), scorerCode: f.code, revision: null };
  const score = (code = request.scorerCode) => sealJournal({ ...report, scorerCode: code });
  return { capture, report, request, score };
}
