import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareV1Data } from '../src/v1-data.js';
import { v1Fixture } from './v1-data-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
it('exports reproducible development features offline; rejects wrong SHA, overwrites and unsafe input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dota-v1-features-')), input = join(directory, 'dataset.json');
  const content = JSON.stringify(prepareV1Data(v1Fixture()));
  const invoke = (digest: string, output: string) => spawnSync(process.execPath,
    [join(root, 'scripts/prepare-v1-features.mjs'), 'export', input, digest, join(directory, output)],
    { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  try {
    await writeFile(input, content);
    const first = invoke(sha(content), 'first.json'); expect(first.error).toBeUndefined(); expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ summary: { maps: 6, featureReady: 1, unavailable: 5 },
      evaluation: 'not_performed', deployable: false, teamAWinProbability: null });
    const original = await readFile(join(directory, 'first.json'), 'utf8');
    expect(JSON.parse(original).syntheticOnly).toBe(true);
    const replay = invoke(sha(content), 'second.json'); expect(replay.status).toBe(0);
    expect(await readFile(join(directory, 'second.json'), 'utf8')).toBe(original);
    expect(invoke(sha(content), 'first.json').stderr).toContain('OUTPUT_EXISTS');
    expect(await readFile(join(directory, 'first.json'), 'utf8')).toBe(original);
    await writeFile(input, 'secret-invalid-input');
    const invalid = invoke(sha(content), 'bad.json'); expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('V1_FEATURE_SOURCE_SHA_MISMATCH');
    expect(invalid.stderr).not.toContain('secret-invalid-input');
    expect(await readdir(directory)).not.toContain('bad.json');
  } finally {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  }
}, 30000);
