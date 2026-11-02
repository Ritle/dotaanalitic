import { expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releasePlanFixture } from '../../db/tests/v1-release-plan-fixtures.js';
import { prepareV1Data } from '../../db/src/v1-data.js';
import { registerV1Candidate } from '../../db/src/v1-candidate.js';
import { canonicalContextJson } from '../../db/src/temporal.js';
import { releaseEvidenceFixture, releaseSha, reseal } from './v1-release-evidence-fixtures.js';
import { freezeV1ReleaseCapture } from '../src/v1-release-evidence.js';
import { registerV1ExecutableFreeze } from '../../db/src/v1-executable-freeze.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function runV1ReleaseCliScenario(databaseUrl?: string, frozen = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dota-release-')), files: string[] = [], directories: string[] = [];
  const save = async (name: string, value: unknown) => {
    const path = join(dir, name), bytes = JSON.stringify(value); await writeFile(path, bytes, { flag: 'wx' }); files.push(path);
    return { path, sha256: releaseSha(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const sealed = <T extends object>(body: T) => ({ ...body, fingerprint: releaseSha(canonicalContextJson(body)) });
  const run = (args: string[]) => spawnSync(process.execPath, args,
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, DATABASE_URL: databaseUrl ?? 'invalid-offline-sentinel' } });
  try {
    const original = releasePlanFixture();
    const base: typeof original = JSON.parse(JSON.stringify(original).replaceAll('2026-', '2025-'), (key, v: unknown) => {
      if (key.endsWith('Us') && typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) >= BigInt(Date.parse('2026-01-01')) * 1000n)
        return (BigInt(v) - 365n * 86400000000n).toString();
      return v;
    });
    base.development = prepareV1Data(base.development.source);
    const catalogue = await save('catalogue.json', base.catalogue), development = await save('development.json', base.development);
    base.request.catalogueSha256 = catalogue.sha256; base.request.developmentDatasetSha256 = development.sha256;
    const f = releaseEvidenceFixture(base), plan = await save('plan.json', f.plan);
    const codeResult = run(['--input-type=module', '-e',
      "import {candidateCodeManifest} from './scripts/lib/v1-candidate-files.mjs'; import {releaseExecutionCode,releaseRuntime} from './scripts/lib/v1-release-files.mjs'; console.log(JSON.stringify({candidate:await candidateCodeManifest(),execution:await releaseExecutionCode(),runtime:await releaseRuntime()}));"]);
    expect(codeResult.status, codeResult.stderr).toBe(0);
    const code = JSON.parse(codeResult.stdout) as { candidate: { path: string; sha256: string }[]; execution: { path: string; sha256: string }[]; runtime: unknown };
    f.candidate = registerV1Candidate(f.plan, base.catalogue, base.development, plan.sha256, code.candidate, f.candidate.registration.kernelRegisteredAt);
    const candidate = await save('candidate.json', f.candidate);
    const freeze = frozen ? registerV1ExecutableFreeze(f.plan, f.candidate, plan.sha256, candidate.sha256, code.execution, code.runtime,
      new Date(Date.parse(f.candidate.registration.kernelRegisteredAt) + 1000).toISOString()) : undefined;
    const freezeRef = freeze ? await save('freeze.json', freeze) : undefined;
    const config = await save('discovery-config.json', { kind: 'v1', planPath: plan.path, planSha256: plan.sha256,
      evidenceAPath: catalogue.path, evidenceBPath: development.path, limits: f.limits });
    for (const n of ['discovery', 'detail']) { const path = join(dir, n); await mkdir(path); directories.push(path); }
    const request = await save('discovery/request.json', {}), receipts = [];
    for (const [i, entry] of f.entries.entries()) {
      const name = `receipt-${String(i).padStart(3, '0')}.json`, ref = await save(`discovery/${name}`, entry);
      receipts.push({ ...ref, path: name });
    }
    const runManifest = await save('discovery/manifest.json', sealed({ format: 'evaluation-discovery-run-v1', configSha256: config.sha256,
      request, receipts, ledger: f.ledger }));
    const union = await save('union.json', sealed({ schemaVersion: 1, format: 'evaluation-discovery-union-v1', configSha256: config.sha256,
      runs: [{ directory: join(dir, 'discovery'), manifestSha256: runManifest.sha256 }], ledger: f.ledger,
      aggregation: 'all_supplied_runs_union_no_removal_or_conflict_overwrite', sourceHistoryCompleteness: 'only_explicitly_supplied_runs', metrics: null, deployable: false }));
    const detailRequest = await save('detail/request.json', {}), detailRefs = [];
    for (const [i, entry] of f.detailEntries.entries()) {
      const name = `receipt-${String(i).padStart(3, '0')}.json`, ref = await save(`detail/${name}`, entry); detailRefs.push({ ...ref, path: name });
    }
    const detail = await save('detail/manifest.json', sealed({ format: 'evaluation-details-capture-v1', unionSha256: union.sha256,
      discoveryFingerprint: f.ledger.fingerprint, request: detailRequest, receipts: detailRefs, assessment: f.batches[0]!.report }));
    const refs = { planPath: plan.path, planSha256: plan.sha256, cataloguePath: catalogue.path, developmentPath: development.path,
      candidatePath: candidate.path, candidateSha256: candidate.sha256, ...(freezeRef ? { freeze: { path: freezeRef.path, sha256: freezeRef.sha256 } } : {}), evidence: { configPath: config.path, configSha256: config.sha256,
        unionPath: union.path, unionSha256: union.sha256, batches: [{ directory: join(dir, 'detail'), manifestSha256: detail.sha256 }] } };
    const execution = await save('execution.json', refs);
    const replay = run(['--input-type=module', '-e',
      "import {readReleaseFiles,verifyReleaseContext,loadReleaseEvidence} from './scripts/lib/v1-release-files.mjs'; const c=await verifyReleaseContext(await readReleaseFiles(process.argv[1],process.argv[2])); await loadReleaseEvidence(c);",
      execution.path, execution.sha256]);
    expect(replay.status, replay.stderr).toBe(0);
    const capture = await save('capture.json', freezeV1ReleaseCapture(f.plan, f.candidate, f.inventory, f.ledger, f.batches,
      f.plan.evaluateNotBefore, refs, execution.sha256, code.execution, freeze));
    const command = (...args: string[]) => run(['scripts/release-execute.mjs', ...args]);
    const result = command('verify', execution.path, execution.sha256, capture.path, capture.sha256);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'release_capture_verified', coverage: { dataReadyMaps: 2 },
      evaluation: 'not_performed', deployable: false, teamAWinProbability: null });
    expect(JSON.parse(command('check', execution.path, execution.sha256).stdout)).toMatchObject({ sourceEvidenceChecked: false, scoringImplemented: true });
    if (freezeRef) {
      expect(run(['scripts/freeze-v1-release.mjs', 'verify', execution.path, execution.sha256, freezeRef.path, freezeRef.sha256]).status).toBe(0);
      // A different, valid pre-test registration is not the artifact pinned by the config.
      const savedCapture = JSON.parse(await readFile(capture.path, 'utf8'));
      const substituted = await save('substituted-freeze-capture.json', reseal({ ...savedCapture,
        executableFreeze: reseal({ ...freeze!, registeredAt: new Date(Date.parse(freeze!.registeredAt) + 1000).toISOString() }) }));
      const substitutedResult = command('verify', execution.path, execution.sha256, substituted.path, substituted.sha256);
      expect(substitutedResult.stderr, substitutedResult.stderr).toContain('RELEASE_CAPTURE_CONTEXT_MISMATCH');
      const freezeBytes = await readFile(freezeRef.path, 'utf8'); await writeFile(freezeRef.path, 'private-freeze-sentinel');
      const tamper = command('check', execution.path, execution.sha256);
      expect(tamper.status).toBe(1); expect(tamper.stderr).not.toContain('private-freeze-sentinel');
      await writeFile(freezeRef.path, freezeBytes);
    }
    const reportPath = join(dir, 'report.json'); files.push(reportPath);
    const scored = command('evaluate', execution.path, execution.sha256, capture.path, capture.sha256, reportPath);
    expect(scored.status, scored.stderr).toBe(databaseUrl ? 0 : 1);
    const reportBytes = await readFile(reportPath, 'utf8');
    if (databaseUrl) {
      const report = JSON.parse(reportBytes);
      expect(report.report.executableFreezeComplete).toBe(frozen);
      expect(report).toMatchObject({ journal: { revision: 1 }, report: { coverage: { scoredMaps: 2 },
        evaluation: { syntheticOnly: true, qualityDecision: 'insufficient_evidence' }, releaseGatePassed: false } });
      const journalCommand = (...args: string[]) => run(['scripts/release-journal.mjs', ...args]);
      const recovered = join(dir, 'recovered.json'), recoveredCapture = join(dir, 'recovered-capture.json');
      files.push(recovered, recoveredCapture);
      expect(journalCommand('export', f.plan.fingerprint, '1', recovered).status).toBe(0);
      expect(await readFile(recovered, 'utf8')).toBe(reportBytes);
      expect(journalCommand('export-capture', f.plan.fingerprint, '1', recoveredCapture).status).toBe(0);
      expect(releaseSha(await readFile(recoveredCapture, 'utf8'))).toBe(capture.sha256);
      const retry = join(dir, 'retry.json'); files.push(retry);
      const repeated = command('evaluate', execution.path, execution.sha256, capture.path, capture.sha256, retry);
      expect(JSON.parse(repeated.stdout).journal.status).toBe('already_recorded');
      expect(await readFile(retry, 'utf8')).toBe(reportBytes);
      const priorCaptureBytes = await readFile(capture.path, 'utf8'), changedBytes = priorCaptureBytes + '\n';
      await writeFile(capture.path, changedBytes); const changedSha = releaseSha(changedBytes);
      const forbidden = join(dir, 'forbidden.json'); files.push(forbidden);
      expect(command('evaluate', execution.path, execution.sha256, capture.path, changedSha, forbidden).stderr).toContain('JOURNAL_REVISION_REQUIRED');
      expect(await readFile(forbidden, 'utf8')).toBe('');
      const revision = await save('revision.json', { parentRevision: 1, parentReportSha256: releaseSha(reportBytes), reason: 'Synthetic capture-byte recapture review' });
      const revised = join(dir, 'revised.json'); files.push(revised);
      const revisionResult = command('revise', execution.path, execution.sha256, capture.path, changedSha, revision.path, revision.sha256, revised);
      expect(revisionResult.status, revisionResult.stderr).toBe(0);
      expect(JSON.parse(revisionResult.stdout).journal.revision).toBe(2);
      expect(JSON.parse(await readFile(revised, 'utf8')).report).toEqual(report.report);
      expect(JSON.parse(journalCommand('list', f.plan.fingerprint).stdout).revisions).toHaveLength(2);
      await writeFile(capture.path, priorCaptureBytes);
    } else {
      expect(reportBytes).toBe(''); expect(scored.stdout).toBe(''); expect(scored.stderr).not.toContain('invalid-offline-sentinel');
    }
    expect(command('evaluate', execution.path, execution.sha256, capture.path, capture.sha256, reportPath).stderr).toContain('OUTPUT_EXISTS');
    const missing = await save('missing.json', { ...refs, evidence: { ...refs.evidence, batches: [] } });
    expect(command('verify', missing.path, missing.sha256, capture.path, capture.sha256).stderr).toContain('RELEASE_DETAIL_BATCHES');
    const rawPath = join(dir, 'detail', detailRefs[2]!.path);
    const raw = await readFile(rawPath, 'utf8'); await writeFile(rawPath, 'private-source-sentinel');
    const corrupt = command('verify', execution.path, execution.sha256, capture.path, capture.sha256);
    expect(corrupt.status).toBe(1); expect(corrupt.stdout).toBe(''); expect(corrupt.stderr).not.toContain('private-source-sentinel');
    await writeFile(rawPath, raw);
    expect(command('verify', execution.path, execution.sha256, capture.path, '0'.repeat(64)).stderr).toContain('DISCOVERY_FILE_SHA_MISMATCH');
    // A future clock sentinel must fail before source/DB/output is touched.
    const future = await save('future-plan.json', { evaluateNotBefore: '2999-01-01T00:00:00.000Z' });
    const early = await save('early.json', { ...refs, planPath: future.path, planSha256: future.sha256, candidatePath: 'missing-candidate' });
    const output = join(dir, 'must-not-exist.json'); files.push(output);
    expect(command('capture', early.path, early.sha256, output).stderr).toContain('RELEASE_CAPTURE_TOO_EARLY');
    expect(command('verify', early.path, early.sha256, 'missing-capture', '0'.repeat(64)).stderr).toContain('RELEASE_CAPTURE_TOO_EARLY');
    expect(command('evaluate', early.path, early.sha256, 'missing-capture', '0'.repeat(64), output).stderr).toContain('RELEASE_CAPTURE_TOO_EARLY');
    expect(command('revise', early.path, early.sha256, 'missing-capture', '0'.repeat(64), 'missing-revision', '0'.repeat(64), output).stderr).toContain('RELEASE_CAPTURE_TOO_EARLY');
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    for (const file of files.reverse()) await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    for (const path of directories.reverse()) await rmdir(path); await rmdir(dir);
  }
}
