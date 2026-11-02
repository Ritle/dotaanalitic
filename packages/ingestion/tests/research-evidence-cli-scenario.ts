import { expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executionFixture } from '../../db/tests/research-execution-fixtures.js';
import { planResearchElo } from '../../db/src/research-plan.js';
import { freezeResearchElo } from '../../db/src/research-elo.js';
import { canonicalContextJson } from '../../db/src/temporal.js';
import { evidenceFixture, digest } from './research-evidence-fixtures.js';
import { buildEvaluationDiscoveryLedger } from '../src/evaluation-discovery.js';
import { validateEvaluationDetails } from '../src/evaluation-details.js';
import { freezeEvidenceResearchExecution } from '../src/research-evidence.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function runEvidenceCliScenario(databaseUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'dota-bound-e1-')), files: string[] = [], directories: string[] = [];
  const save = async (name: string, value: unknown) => {
    const path = join(dir, name), bytes = JSON.stringify(value); await writeFile(path, bytes, { flag: 'wx' }); files.push(path);
    return { path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const sealed = <T extends object>(body: T) => ({ ...body, fingerprint: digest(canonicalContextJson(body)) });
  try {
    const original = executionFixture();
    const base: typeof original = JSON.parse(JSON.stringify(original).replaceAll('2026-', '2025-'), (key, v: unknown) => {
      if (key.endsWith('Us') && typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) >= BigInt(Date.parse('2026-01-01')) * 1000n)
        return (BigInt(v) - 365n * 86400000000n).toString();
      return v;
    });
    const { fingerprint: _old, ...priorBody } = base.sources.prior; base.sources.prior = freezeResearchElo(priorBody);
    const prior = await save('prior.json', base.sources.prior), discovery = await save('prior-discovery.json', base.sources.discovery);
    base.sources.request.priorExportSha256 = prior.sha256; base.sources.request.discoverySha256 = discovery.sha256;
    base.plan = planResearchElo(base.sources.request, base.sources.prior, base.sources.discovery, base.plan.registeredAt);
    const plan = await save('plan.json', base.plan), f = evidenceFixture(['201', '202', '203'], false, base);
    const limits = { maxProPages: 1, maxLeagues: 1 };
    const config = await save('config.json', { kind: 'e1', planPath: plan.path, planSha256: plan.sha256,
      evidenceAPath: prior.path, evidenceBPath: discovery.path, limits });
    const metadata = f.ledger.candidates.map(c => c.metadata), rawBody = JSON.stringify(metadata), at = f.ledger.completedAt;
    const entries = ['/proMatches', '/leagues/77/matches'].map((endpoint, sequence) => ({ status: 'captured', sequence, endpoint,
      fetchedAt: at, rawBody, payloadSha256: digest(rawBody) }));
    const ledger = buildEvaluationDiscoveryLedger({ ...f.ledger.scope, planSha256: plan.sha256 }, entries, at, at, limits, ['PRO_PAGE_LIMIT']);
    for (const n of ['discovery', 'detail']) { const path = join(dir, n); await mkdir(path); directories.push(path); }
    const request = await save('discovery/request.json', {}), receipts = [];
    for (const [i, e] of entries.entries()) {
      const name = `receipt-${String(i).padStart(3, '0')}.json`, ref = await save(`discovery/${name}`, e);
      receipts.push({ ...ref, path: name });
    }
    const run = await save('discovery/manifest.json', sealed({ format: 'evaluation-discovery-run-v1', configSha256: config.sha256,
      request, receipts, ledger }));
    const union = await save('union.json', sealed({ schemaVersion: 1, format: 'evaluation-discovery-union-v1', configSha256: config.sha256,
      runs: [{ directory: join(dir, 'discovery'), manifestSha256: run.sha256 }], ledger,
      aggregation: 'all_supplied_runs_union_no_removal_or_conflict_overwrite', sourceHistoryCompleteness: 'only_explicitly_supplied_runs', metrics: null, deployable: false }));
    const detailRequest = await save('detail/request.json', {}), detailRefs = [], detailEntries = f.captures[0]!.entries;
    for (const [i, e] of detailEntries.entries()) {
      const name = `receipt-${String(i).padStart(3, '0')}.json`, ref = await save(`detail/${name}`, e); detailRefs.push({ ...ref, path: name });
    }
    const report = validateEvaluationDetails(ledger, detailEntries, 0, at, at).report;
    const detail = await save('detail/manifest.json', sealed({ format: 'evaluation-details-capture-v1', unionSha256: union.sha256,
      discoveryFingerprint: ledger.fingerprint, request: detailRequest, receipts: detailRefs, assessment: report }));
    const evidence = { configPath: config.path, configSha256: config.sha256, unionPath: union.path, unionSha256: union.sha256,
      batches: [{ directory: join(dir, 'detail'), manifestSha256: detail.sha256 }] };
    const refs = await save('evidence.json', evidence);
    const captured = freezeEvidenceResearchExecution(base.plan, f.snapshot, f.now, f.code, evidence, ledger, [report]);
    const capture = await save('capture.json', captured), output = join(dir, 'report.json'); files.push(output);
    const common = [plan.path, plan.sha256, prior.path, discovery.path];
    const command = (mode: string, rest: string[]) => spawnSync(process.execPath, [join(root, 'scripts/execute-research-elo.mjs'), mode, ...common, ...rest],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, DATABASE_URL: databaseUrl ?? 'invalid-offline-sentinel' } });
    const checked = command('evidence', [refs.path, refs.sha256]); expect(checked.status, checked.stderr).toBe(0);
    const result = command('evaluate', [capture.path, capture.sha256, output]);
    expect(result.status, result.stderr).toBe(databaseUrl ? 0 : 1);
    const bytes = await readFile(output, 'utf8');
    if (databaseUrl) {
      expect(JSON.parse(bytes)).toMatchObject({ journal: { revision: 1 }, report: { coverage: { observedTargetMaps: 3, scoredMaps: 1 }, evaluation: { syntheticOnly: true }, deployable: false } });
      const journalCommand = (mode: string, rest: string[]) => spawnSync(process.execPath,
        [join(root, 'scripts/research-journal.mjs'), mode, base.plan.fingerprint, ...rest],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, DATABASE_URL: databaseUrl } });
      const recovered = join(dir, 'recovered.json'); files.push(recovered);
      expect(journalCommand('export', ['1', recovered]).status).toBe(0);
      expect(await readFile(recovered, 'utf8')).toBe(bytes);
      const recoveredCapture = join(dir, 'recovered-capture.json'); files.push(recoveredCapture);
      expect(journalCommand('export-capture', ['1', recoveredCapture]).status).toBe(0);
      expect(digest(await readFile(recoveredCapture, 'utf8'))).toBe(capture.sha256);
      const retry = join(dir, 'retry.json'); files.push(retry);
      const repeated = command('evaluate', [capture.path, capture.sha256, retry]);
      expect(repeated.status, repeated.stderr).toBe(0); expect(JSON.parse(repeated.stdout).journal.status).toBe('already_recorded');
      expect(await readFile(retry, 'utf8')).toBe(bytes);
      // A byte-level recapture is a changed input and must be declared, even if its logical values are the same.
      const changedText = (await readFile(capture.path, 'utf8')) + '\n';
      await writeFile(capture.path, changedText); const changedSha = digest(changedText);
      const forbidden = join(dir, 'forbidden.json'); files.push(forbidden);
      expect(command('evaluate', [capture.path, changedSha, forbidden]).stderr).toContain('JOURNAL_REVISION_REQUIRED');
      expect(await readFile(forbidden, 'utf8')).toBe('');
      const revision = await save('revision.json', { parentRevision: 1, parentReportSha256: digest(bytes), reason: 'Synthetic byte-preserving recapture review' });
      const revisionOutput = join(dir, 'revision-report.json'); files.push(revisionOutput);
      const revised = command('revise', [capture.path, changedSha, revision.path, revision.sha256, revisionOutput]);
      expect(revised.status, revised.stderr).toBe(0); expect(JSON.parse(revised.stdout).journal.revision).toBe(2);
      expect(JSON.parse(await readFile(revisionOutput, 'utf8')).report).toEqual(JSON.parse(bytes).report);
      expect(JSON.parse(journalCommand('list', []).stdout).revisions).toHaveLength(2);
      await writeFile(capture.path, changedText.slice(0, -1));
    } else {
      expect(result.stdout).toBe(''); expect(bytes).toBe('');
      expect(result.stderr).not.toContain('invalid-offline-sentinel');
    }
    expect(command('evaluate', [capture.path, capture.sha256, output]).stderr).toContain('OUTPUT_EXISTS');
    const missing = await save('missing.json', { ...evidence, batches: [] });
    expect(command('evidence', [missing.path, missing.sha256]).stderr).toContain('EXECUTION_EVIDENCE_BATCHES');
    await writeFile(join(dir, 'detail', detailRefs[2]!.path), 'private-source-sentinel');
    const corrupt = command('evaluate', [capture.path, capture.sha256, output]);
    expect(corrupt.status).toBe(1); expect(corrupt.stderr).not.toContain('private-source-sentinel');
    expect(await readFile(output, 'utf8')).toBe(bytes);
  } finally {
    for (const file of files.reverse()) await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    for (const path of directories.reverse()) await rmdir(path); await rmdir(dir);
  }
}
