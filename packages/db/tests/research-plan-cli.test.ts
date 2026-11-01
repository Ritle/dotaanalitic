import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planFixture, digest } from './research-plan-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
it('creates and verifies a pinned offline plan, rejects overwrite, changed sources and forged selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dota-e1-')), f = planFixture();
  // This is a synthetic CLI test, not a real preregistration. Keep its window future-dated.
  f.request.holdoutFromAt = '2099-01-01T00:00:00.000Z'; f.request.holdoutUntil = '2099-01-08T00:00:00.000Z';
  f.request.evaluationNotBefore = '2099-01-09T00:00:00.000Z';
  const paths = Object.fromEntries(['request', 'prior', 'discovery', 'plan'].map(n => [n, join(dir, n + '.json')]));
  const invoke = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/plan-research-elo.mjs'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  try {
    await writeFile(paths.request!, JSON.stringify(f.request)); await writeFile(paths.prior!, JSON.stringify(f.prior));
    await writeFile(paths.discovery!, JSON.stringify(f.discovery));
    const args = ['create', paths.request!, paths.prior!, paths.discovery!, paths.plan!];
    const created = invoke(args); expect(created.error).toBeUndefined(); expect(created.status).toBe(0);
    const original = await readFile(paths.plan!, 'utf8'), sha = digest(original);
    expect(JSON.parse(original)).toMatchObject({ syntheticOnly: true, trainingReady: false, warmup: { candidateMaps: 3 } });
    expect(invoke(['verify', paths.plan!, sha, paths.prior!, paths.discovery!]).status).toBe(0);
    const duplicate = invoke(args); expect(duplicate.status).toBe(1); expect(duplicate.stderr).toContain('OUTPUT_EXISTS');
    expect(await readFile(paths.plan!, 'utf8')).toBe(original);
    const forged = JSON.parse(original); forged.warmup.candidateMaps = 999; const forgedBytes = JSON.stringify(forged);
    await writeFile(paths.plan!, forgedBytes);
    expect(invoke(['verify', paths.plan!, digest(forgedBytes), paths.prior!, paths.discovery!]).status).toBe(1);
    await writeFile(paths.plan!, original); await writeFile(paths.discovery!, 'private-source-sentinel');
    const changed = invoke(['verify', paths.plan!, sha, paths.prior!, paths.discovery!]);
    expect(changed.status).toBe(1); expect(changed.stderr).not.toContain('private-source-sentinel');
  } finally { for (const path of Object.values(paths)) await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); await rmdir(dir); }
}, 20000);
