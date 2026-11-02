import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareV1Data } from '../src/v1-data.js';
import { v1Fixture } from './v1-data-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
it('verifies offline without DB, preserves bytes, checks external SHA first and hides invalid input secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dota-v1-data-')), path = join(directory, 'dataset.json');
  const content = JSON.stringify(prepareV1Data(v1Fixture()));
  const invoke = (digest: string) => spawnSync(process.execPath, [join(root, 'scripts/prepare-v1-data.mjs'), 'verify', path, digest],
    { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  try {
    await writeFile(path, content); const result = invoke(sha(content));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'verified', summary: { eligibleMaps: 6 }, trainingReady: false, deployable: false });
    expect(await readFile(path, 'utf8')).toBe(content);
    await writeFile(path, 'secret-invalid-input'); const invalid = invoke(sha(content));
    expect(invalid.status).toBe(1); expect(invalid.stderr).toContain('V1_FILE_SHA_MISMATCH');
    expect(invalid.stderr).not.toContain('secret-invalid-input');
  } finally { await unlink(path); await rmdir(directory); }
}, 20000);
