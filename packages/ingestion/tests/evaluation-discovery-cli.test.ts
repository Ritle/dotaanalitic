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
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
it('collects a future plan offline, verifies immutable files and merges all supplied runs without replacing old observations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dota-discovery-'));
  const paths = Object.fromEntries(['config', 'plan', 'catalogue', 'development', 'refs', 'union', 'union2'].map(n => [n, join(dir, n + '.json')]));
  const runs = [join(dir, 'run1'), join(dir, 'run2')];
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/collect-evaluation-discovery.mjs'), ...args],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  try {
    const f = releasePlanFixture();
    f.request.events[0]!.fromAt = '2099-11-20T00:00:00.000Z'; f.request.events[0]!.until = '2099-11-30T00:00:00.000Z'; f.request.snapshotAt = '2099-12-02T00:00:00.000Z';
    const plan = planV1Release(f.request, f.catalogue, f.development, f.registeredAt), planBytes = JSON.stringify(plan);
    await writeFile(paths.plan!, planBytes); await writeFile(paths.catalogue!, JSON.stringify(f.catalogue)); await writeFile(paths.development!, JSON.stringify(f.development));
    const config = { kind: 'v1', planPath: paths.plan, planSha256: sha(planBytes), evidenceAPath: paths.catalogue, evidenceBPath: paths.development,
      limits: { maxProPages: 1, maxLeagues: 1 } };
    await writeFile(paths.config!, JSON.stringify(config));
    const refs = [];
    for (const destination of runs) {
      const collected = run(['collect', paths.config!, destination]); expect(collected.error).toBeUndefined(); expect(collected.status, collected.stderr).toBe(0);
      expect(JSON.parse(collected.stdout)).toMatchObject({ status: 'not_started', metrics: null, summary: { uniqueMaps: 0, sourceResponses: 0 } });
      const original = await readFile(join(destination, 'manifest.json'), 'utf8'), hash = sha(original);
      expect(run(['verify', paths.config!, destination, hash]).status).toBe(0);
      expect(run(['collect', paths.config!, destination]).stderr).toContain('OUTPUT_EXISTS');
      expect(await readFile(join(destination, 'manifest.json'), 'utf8')).toBe(original);
      refs.push({ directory: destination, manifestSha256: hash });
    }
    await writeFile(paths.refs!, JSON.stringify(refs));
    expect(run(['merge', paths.config!, paths.refs!, paths.union!]).status).toBe(0);
    expect(run(['merge', paths.config!, paths.refs!, paths.union2!]).status).toBe(0);
    expect(await readFile(paths.union!, 'utf8')).toBe(await readFile(paths.union2!, 'utf8'));
    const manifestFile = join(runs[0]!, 'manifest.json'), original = await readFile(manifestFile, 'utf8');
    const forged = JSON.parse(original); forged.ledger.summary.uniqueMaps = 99;
    const { fingerprint: _fingerprint, ...body } = forged; forged.fingerprint = sha(canonicalContextJson(body));
    const bytes = JSON.stringify(forged); await writeFile(manifestFile, bytes);
    expect(run(['verify', paths.config!, runs[0]!, sha(bytes)]).stderr).toContain('DISCOVERY_LEDGER_REPLAY_MISMATCH');
    await writeFile(manifestFile, original);
    await writeFile(join(runs[0]!, 'receipt-000.json'), '{}');
    expect(run(['verify', paths.config!, runs[0]!, sha(original)]).stderr).toContain('DISCOVERY_UNMANIFESTED_RECEIPT');
    await unlink(join(runs[0]!, 'receipt-000.json'));
    await writeFile(join(runs[0]!, 'request.json'), 'private-source-sentinel');
    const corrupted = run(['verify', paths.config!, runs[0]!, sha(original)]);
    expect(corrupted.stderr).toContain('DISCOVERY_FILE_SHA_MISMATCH'); expect(corrupted.stderr).not.toContain('private-source-sentinel');
  } finally {
    for (const destination of runs) {
      for (const file of await readdir(destination).catch(() => [])) await unlink(join(destination, file));
      await rmdir(destination).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    for (const path of Object.values(paths)) await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); await rmdir(dir);
  }
}, 60000);
