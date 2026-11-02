import { expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executionFixture } from './research-execution-fixtures.js';
import { planResearchElo } from '../src/research-plan.js';
import { freezeResearchElo } from '../src/research-elo.js';
import { freezeResearchExecution } from '../src/research-execution.js';
import { digest } from './research-plan-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function setup(past: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'dota-e1-execution-'));
  const original = executionFixture();
  // Explicit synthetic dates only; CLI has no environment/argument clock override.
  const f: typeof original = past ? JSON.parse(JSON.stringify(original).replaceAll('2026-', '2025-'), (key, value: unknown) => {
    if (key.endsWith('Us') && typeof value === 'string' && /^\d+$/.test(value)) {
      const n = BigInt(value), start = BigInt(Date.parse('2026-01-01T00:00:00Z')) * 1000n;
      if (n >= start && n < start + 365n * 86400000000n) return (n - 365n * 86400000000n).toString();
    }
    return value;
  }) : original;
  const { fingerprint: _priorHash, ...priorBody } = f.sources.prior;
  f.sources.prior = freezeResearchElo(priorBody);
  f.sources.request.priorExportSha256 = digest(JSON.stringify(f.sources.prior));
  f.sources.request.discoverySha256 = digest(JSON.stringify(f.sources.discovery));
  if (!past) {
    f.sources.request.holdoutFromAt = '2099-01-01T00:00:00.000Z';
    f.sources.request.holdoutUntil = '2099-01-08T00:00:00.000Z';
    f.sources.request.evaluationNotBefore = '2099-01-09T00:00:00.000Z';
  }
  f.plan = planResearchElo(f.sources.request, f.sources.prior, f.sources.discovery, f.plan.registeredAt);
  const paths = Object.fromEntries(['plan', 'prior', 'discovery', 'capture', 'report'].map(n => [n, join(dir, n + '.json')]));
  await writeFile(paths.plan!, JSON.stringify(f.plan)); await writeFile(paths.prior!, JSON.stringify(f.sources.prior));
  await writeFile(paths.discovery!, JSON.stringify(f.sources.discovery));
  const common = [paths.plan!, digest(JSON.stringify(f.plan)), paths.prior!, paths.discovery!];
  const run = (mode: string, rest: string[] = [], args = common) => spawnSync(process.execPath,
    [join(root, 'scripts/execute-research-elo.mjs'), mode, ...args, ...rest],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  const clean = async () => { for (const path of Object.values(paths)) await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); await rmdir(dir); };
  return { f, paths, common, run, clean };
}

it('checks plan offline and refuses early capture/scoring before DB, snapshot reads or file writes', async () => {
  const t = await setup(false);
  try {
    const check = t.run('check'); expect(check.status, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ timeGateOpen: false, metrics: null, deployable: false });
    for (const result of [t.run('capture', ['missing-evidence.json', 'a'.repeat(64), t.paths.capture!]), t.run('evaluate', [t.paths.capture!, 'a'.repeat(64), t.paths.report!])]) {
      expect(result.status).toBe(1); expect(result.stderr).toContain('EXECUTION_TOO_EARLY');
      expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('invalid-offline-sentinel');
    }
    await expect(readFile(t.paths.capture!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(t.paths.report!)).rejects.toMatchObject({ code: 'ENOENT' });
    const forged = { ...t.f.plan, deployable: true }; const bytes = JSON.stringify(forged); await writeFile(t.paths.plan!, bytes);
    const result = t.run('check', [], [t.paths.plan!, digest(bytes), ...t.common.slice(2)]);
    expect(result.stderr).toContain('EXECUTION_PLAN_REPLAY_MISMATCH');
  } finally { await t.clean(); }
}, 20000);

it('refuses legacy capture without candidate evidence and checks its external SHA without exposing source content', async () => {
  const t = await setup(true);
  try {
    const { fingerprint: _snapshotHash, ...body } = t.f.snapshot;
    const capture = freezeResearchExecution(t.f.plan, freezeResearchElo(body), t.f.now, t.f.code);
    const captureBytes = JSON.stringify(capture); await writeFile(t.paths.capture!, captureBytes);
    const args = [t.paths.capture!, digest(captureBytes), t.paths.report!];
    const scored = t.run('evaluate', args); expect(scored.error).toBeUndefined(); expect(scored.status, scored.stderr).toBe(1);
    expect(scored.stderr).toContain('RESEARCH_EXECUTION_REJECTED');
    await expect(readFile(t.paths.report!)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(t.paths.capture!, 'private-source-sentinel');
    const corrupt = t.run('evaluate', args); expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toContain('EXECUTION_SOURCE_SHA_MISMATCH'); expect(corrupt.stderr).not.toContain('private-source-sentinel');
    await expect(readFile(t.paths.report!)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await t.clean(); }
}, 20000);
