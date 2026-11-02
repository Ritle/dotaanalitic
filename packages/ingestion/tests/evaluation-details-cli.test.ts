import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { releasePlanFixture } from '../../db/tests/v1-release-plan-fixtures.js';
import { planV1Release } from '../../db/src/v1-release-plan.js';
import { canonicalContextJson } from '../../db/src/temporal.js';
import { reconcileEvaluationCandidates } from '../src/evaluation-details.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
it('verifies a future empty detail batch and reconciliation offline, rejects overwrite and replay tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dota-details-'));
  const paths = Object.fromEntries(['config', 'plan', 'catalogue', 'development', 'refs', 'union', 'report'].map(n => [n, join(dir, n + '.json')]));
  const discoveryDir = join(dir, 'discovery'), detailsDir = join(dir, 'details');
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  try {
    const f = releasePlanFixture(); f.request.events[0]!.fromAt = '2099-11-20T00:00:00.000Z';
    f.request.events[0]!.until = '2099-11-30T00:00:00.000Z'; f.request.snapshotAt = '2099-12-02T00:00:00.000Z';
    const plan = JSON.stringify(planV1Release(f.request, f.catalogue, f.development, f.registeredAt));
    await writeFile(paths.plan!, plan); await writeFile(paths.catalogue!, JSON.stringify(f.catalogue)); await writeFile(paths.development!, JSON.stringify(f.development));
    await writeFile(paths.config!, JSON.stringify({ kind: 'v1', planPath: paths.plan, planSha256: sha(plan),
      evidenceAPath: paths.catalogue, evidenceBPath: paths.development, limits: { maxProPages: 1, maxLeagues: 1 } }));
    const discovered = run('collect-evaluation-discovery.mjs', ['collect', paths.config!, discoveryDir]); expect(discovered.status, discovered.stderr).toBe(0);
    const manifestSha = JSON.parse(discovered.stdout).manifestSha256;
    await writeFile(paths.refs!, JSON.stringify([{ directory: discoveryDir, manifestSha256: manifestSha }]));
    const merged = run('collect-evaluation-discovery.mjs', ['merge', paths.config!, paths.refs!, paths.union!]); expect(merged.status, merged.stderr).toBe(0);
    const unionBytes = await readFile(paths.union!, 'utf8'), union = JSON.parse(unionBytes), common = [paths.config!, paths.union!, sha(unionBytes)];
    const captured = run('evaluation-details.mjs', ['capture', ...common, '0', detailsDir]); expect(captured.status, captured.stderr).toBe(0);
    const captureBytes = await readFile(join(detailsDir, 'manifest.json'), 'utf8'), capture = JSON.parse(captureBytes), captureSha = sha(captureBytes);
    expect(capture).toMatchObject({ requestStats: { attempts: 0 }, assessment: { metrics: null, deployable: false, assessments: [] } });
    expect(run('evaluation-details.mjs', ['verify', ...common, detailsDir, captureSha]).status).toBe(0);
    expect(run('evaluation-details.mjs', ['capture', ...common, '0', detailsDir]).stderr).toContain('OUTPUT_EXISTS');
    const body = { schemaVersion: 1, format: 'evaluation-reconciliation-envelope-v1', unionSha256: sha(unionBytes), captureSha256: captureSha,
      dataset: f.development, report: reconcileEvaluationCandidates(union.ledger, f.development, capture.assessment), metrics: null, deployable: false };
    const reportBytes = JSON.stringify({ ...body, fingerprint: sha(canonicalContextJson(body)) }); await writeFile(paths.report!, reportBytes);
    const verified = run('evaluation-details.mjs', ['verify-reconciliation', ...common, paths.report!, sha(reportBytes), detailsDir]);
    expect(verified.status, verified.stderr).toBe(0); expect(JSON.parse(verified.stdout).coverage.mapCoverage).toBeNull();
    capture.assessment.selection.selectedIds = ['999'];
    const { fingerprint: _hash, ...forgedBody } = capture; capture.fingerprint = sha(canonicalContextJson(forgedBody));
    const forged = JSON.stringify(capture); await writeFile(join(detailsDir, 'manifest.json'), forged);
    expect(run('evaluation-details.mjs', ['verify', ...common, detailsDir, sha(forged)]).stderr).toContain('DETAIL_ASSESSMENT_REPLAY_MISMATCH');
    await writeFile(join(detailsDir, 'manifest.json'), captureBytes);
    await writeFile(join(detailsDir, 'request.json'), 'private-source-sentinel');
    const changed = run('evaluation-details.mjs', ['verify', ...common, detailsDir, captureSha]);
    expect(changed.stderr).toContain('DISCOVERY_FILE_SHA_MISMATCH'); expect(changed.stderr).not.toContain('private-source-sentinel');
  } finally {
    for (const sub of [discoveryDir, detailsDir]) {
      for (const name of await readdir(sub).catch(() => [])) await unlink(join(sub, name));
      await rmdir(sub).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    for (const path of Object.values(paths)) await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); await rmdir(dir);
  }
}, 60000);
