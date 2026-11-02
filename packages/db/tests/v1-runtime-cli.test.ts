import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registrySha } from '../src/v1-registry.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
const cli = fileURLToPath(new URL('../../../scripts/v1-runtime.mjs', import.meta.url));
it('validates request bytes/purpose before DB access and emits only safe Russian errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v1-runtime-cli-'));
  try {
    const path = join(dir, 'request.json'), body = JSON.stringify({ ...runtimeFixture().request, purpose: 'real_map', secret: 'must-not-echo' });
    writeFileSync(path, body);
    for (const digest of ['0'.repeat(64), registrySha(body)]) {
      const result = spawnSync(process.execPath, [cli, 'create', path, digest], { encoding: 'utf8', windowsHide: true,
        env: { ...process.env, DATABASE_URL: 'postgresql://sensitive-secret@127.0.0.1:1/unreachable' } });
      expect(result.status).toBe(1); expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).code).toBe('V1_RUNTIME_REJECTED');
      expect(result.stderr).not.toMatch(/must-not-echo|sensitive-secret/);
    }
    expect(spawnSync(process.execPath, [cli], { encoding: 'utf8', windowsHide: true }).status).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
