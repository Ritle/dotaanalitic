import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registrySha } from '../src/v1-registry.js';
it('rejects invalid bundle or transition bytes without DB access, secret output or activation', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'v1-registry-'));
  const path = join(dir, 'request.json'), bytes = JSON.stringify({ private: 'private-registry-sentinel' });
  await writeFile(path, bytes);
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/v1-registry.mjs', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, DATABASE_URL: 'private-db-sentinel' } });
  try {
    for (const args of [['transition', path, registrySha(bytes)], ['transition', path, '0'.repeat(64)],
      ['check', dir, '0'.repeat(64), '0'.repeat(64)]]) {
      const result = run(...args); expect(result.status).toBe(1); expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('private-registry-sentinel'); expect(result.stderr).not.toContain('private-db-sentinel');
      expect(JSON.parse(result.stderr)).toMatchObject({ status: 'unavailable', code: 'V1_REGISTRY_REJECTED' });
    }
  } finally { await unlink(path); await rmdir(dir); }
}, 60000);
