import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {expect, it} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sha} from '../../../tools/research/exposure-ledger-core.mjs';
import {sql} from '../dist/index.js';

const script = fileURLToPath(new URL('../../../tools/research/shared-research-artifact.mjs', import.meta.url));

it('shares immutable exact bytes and refuses altered inputs or existing destinations', async () => {
  const database = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'research-artifact-'));
  try {
    const input = join(directory, 'input.json'), output = join(directory, 'download.json');
    const bytes = Buffer.from('{"sample":"synthetic"}\r\n');
    const digest = sha(bytes);
    await writeFile(input, bytes);
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, ...args], {
      env: {...process.env, RESEARCH_DATABASE_URL: database.url}
    });
    await expect(run('put', sha('other payload'), input)).rejects.toMatchObject({stderr:expect.stringContaining('expected SHA-256')});
    const results = await Promise.all([run('put', digest, input), run('put', digest, input)]);
    expect(results.map(result => JSON.parse(result.stdout).status).sort()).toEqual(['already_stored', 'stored']);
    expect(JSON.parse((await run('get', digest, output)).stdout)).toEqual({status:'downloaded',sha256:digest,bytes:bytes.length});
    expect(await readFile(output)).toEqual(bytes);
    await expect(run('get', digest, output)).rejects.toMatchObject({stderr:expect.stringContaining('EEXIST')});
    expect(await readFile(output)).toEqual(bytes);
    await expect(run('get', sha('missing'), output)).rejects.toMatchObject({stderr:expect.stringContaining('No artifact found')});
    await expect(sql`INSERT INTO research_artifacts(sha256, body) VALUES (${sha('wrong')}, ${bytes})`.execute(database.db))
      .rejects.toMatchObject({code:'23514'});
    await expect(sql`DELETE FROM research_artifacts`.execute(database.db)).rejects.toThrow('Immutable');
    await expect(sql`TRUNCATE research_artifacts`.execute(database.db)).rejects.toThrow('Immutable');
  } finally {
    await database.close();
    await rm(directory, {recursive:true, force:true});
  }
}, 60000);
