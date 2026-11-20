import {afterAll, beforeAll, expect, it} from 'vitest';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, unlink, rmdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { database = await testDatabase(); }, 60000);
afterAll(async () => { await database?.close(); }, 30000);

it('rejects an unregistered experiment from the CLI before consuming quota or creating an archive', async () => {
  const owner = await sql<{id: string}>`INSERT INTO app_users(login,password_hash,account_role)
    VALUES ('fixture-remote-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db);
  const dir = await mkdtemp(join(tmpdir(), 'draft-remote-request-'));
  const path = join(dir, 'request.json');
  try {
    await writeFile(path, JSON.stringify({mode: 'opendota-remote', ownerId: owner.rows[0]!.id,
      registrationId: randomUUID(), registrationSha256: 'b'.repeat(64), operationId: randomUUID()}));
    const result = await new Promise<{code: number | string | undefined, stdout: string, stderr: string}>(resolve => {
      execFile(process.execPath, ['tools/research/run-conditional-collection-v2-remote.mjs', '--request', path],
        {windowsHide: true, env: {...process.env, DATABASE_URL: database.url, OPENDOTA_API_KEY: 'synthetic-private-key'}},
        (error, stdout, stderr) => resolve({code: error?.code, stdout, stderr}));
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).status).toBe('blocked');
    expect(result.stderr).not.toContain('synthetic-private-key');
    const counts = await sql`SELECT (SELECT count(*)::int FROM provider_quotas) AS quotas,
      (SELECT count(*)::int FROM conditional_blob_archives) AS archives,
      (SELECT count(*)::int FROM conditional_collection_v2_events) AS events`.execute(database.db);
    expect(counts.rows[0]).toEqual({quotas: 0, archives: 0, events: 0});
  } finally {
    await unlink(path);
    await rmdir(dir);
  }
});
