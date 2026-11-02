import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releasePlanFixture, releaseDigest } from './v1-release-plan-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
it('registers/verifies offline, refuses overwrite and rejects edited gates and corrupt sources without exposing them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dota-v1-release-')), f = releasePlanFixture();
  f.request.events[0]!.fromAt = '2099-11-20T00:00:00.000Z'; f.request.events[0]!.until = '2099-11-30T00:00:00.000Z';
  f.request.snapshotAt = '2099-12-02T00:00:00.000Z';
  const paths = Object.fromEntries(['request', 'catalogue', 'development', 'plan'].map(n => [n, join(dir, n + '.json')]));
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/plan-v1-release.mjs'), ...args],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  try {
    await writeFile(paths.request!, JSON.stringify(f.request)); await writeFile(paths.catalogue!, JSON.stringify(f.catalogue));
    await writeFile(paths.development!, JSON.stringify(f.development));
    const create = ['create', paths.request!, paths.catalogue!, paths.development!, paths.plan!];
    const result = run(create); expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const original = await readFile(paths.plan!, 'utf8');
    const verify = ['verify', paths.plan!, releaseDigest(original), paths.catalogue!, paths.development!];
    expect(run(verify).status).toBe(0); expect(run(create).stderr).toContain('OUTPUT_EXISTS');
    const changed = JSON.parse(original); changed.qualityPolicy.sample.minMaps = 1;
    const forged = JSON.stringify(changed); await writeFile(paths.plan!, forged);
    expect(run(['verify', paths.plan!, releaseDigest(forged), paths.catalogue!, paths.development!]).stderr).toContain('RELEASE_PLAN_REPLAY_MISMATCH');
    await writeFile(paths.plan!, original); await writeFile(paths.catalogue!, 'private-source-sentinel');
    const badSource = run(verify); expect(badSource.status).toBe(1);
    expect(badSource.stderr).toContain('RELEASE_SOURCE_SHA_MISMATCH'); expect(badSource.stderr).not.toContain('private-source-sentinel');
    expect(await readFile(paths.plan!, 'utf8')).toBe(original);
  } finally { for (const path of Object.values(paths)) await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); await rmdir(dir); }
}, 30000);
