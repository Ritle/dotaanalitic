import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { freezeResearchElo } from '../src/research-elo.js';
import { researchFixture } from './research-elo-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function workspace(work: (dir: string, content: string, invoke: (output: string, expectedSha?: string) => ReturnType<typeof spawnSync>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'dota-e0-')), content = JSON.stringify(freezeResearchElo(researchFixture()));
  await writeFile(join(dir, 'input.json'), content);
  const invoke = (output: string, expectedSha = sha(content)) => spawnSync(process.execPath,
    [join(root, 'scripts/research-elo.mjs'), 'evaluate', join(dir, 'input.json'), expectedSha, join(dir, output)],
    { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel', SECRET_TEST: 'never-print-this-secret' } });
  try { await work(dir, content, invoke); }
  finally { for (const name of ['input.json', 'one.json', 'two.json']) await unlink(join(dir, name)).catch(e => { if (e.code !== 'ENOENT') throw e; }); await rmdir(dir); }
}
it('offline CLI replays byte-identically with a broken DB URL and refuses to overwrite', () => workspace(async (dir, content, invoke) => {
  const first = invoke('one.json'); expect(first.error).toBeUndefined(); expect(first.status).toBe(0);
  expect(invoke('two.json').status).toBe(0);
  const before = await readFile(join(dir, 'one.json')); expect(await readFile(join(dir, 'two.json'))).toEqual(before);
  const existing = invoke('one.json'); expect(existing.status).toBe(1); expect(String(existing.stderr)).toContain('OUTPUT_EXISTS');
  expect(await readFile(join(dir, 'one.json'))).toEqual(before);
  expect(JSON.parse(before.toString())).toMatchObject({ syntheticOnly: true, trainingReady: false, deployable: false });
}));
it('checks source SHA before parsing and keeps error responses free of input secrets', () => workspace(async (dir, content, invoke) => {
  await writeFile(join(dir, 'input.json'), 'never-print-this-secret');
  const bad = invoke('one.json'); expect(bad.status).toBe(1); expect(String(bad.stderr)).not.toContain('never-print-this-secret');
  await writeFile(join(dir, 'input.json'), Buffer.from([255]));
  expect(invoke('one.json', sha(Buffer.from([255]))).status).toBe(1);
}));
