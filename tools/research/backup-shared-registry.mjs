import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdir, mkdtemp, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {promisify} from 'node:util';
import pg from 'pg';
import {sha} from './exposure-ledger-core.mjs';

const run = promisify(execFile);
const fields = ['mapIds', 'openDotaSeriesIds', 'pandaScoreMeetingIds'];
const tables = ['research_exposure_snapshots', 'research_artifacts'];
const [pgBin, outputDir] = process.argv.slice(2);
assert(pgBin && outputDir && process.argv.length === 4, 'usage: backup-shared-registry PG_BIN OUTPUT_DIRECTORY');
assert(process.env.RESEARCH_DATABASE_URL, 'RESEARCH_DATABASE_URL required');
assert(URL.canParse(process.env.RESEARCH_DATABASE_URL), 'Invalid registry connection URL');
const source = new URL(process.env.RESEARCH_DATABASE_URL);
assert(['postgresql:', 'postgres:'].includes(source.protocol) && source.hostname && source.pathname.length > 1,
  'Expected an explicit PostgreSQL host and database');
const backupPort = process.env.RESEARCH_BACKUP_TUNNEL_PORT;
if (backupPort) {
  assert.equal(source.hostname, '127.0.0.1', 'SSH tunnel requires a loopback connection');
  assert(/^[1-9][0-9]{0,4}$/.test(backupPort) && Number(backupPort) <= 65535, 'invalid tunnel port');
  source.port = backupPort;
}
const db = new pg.Client({connectionString: source.toString(), connectionTimeoutMillis: 8000, statement_timeout: 30000});
const password = decodeURIComponent(source.password);
source.password = '';
const env = {...process.env, PGPASSWORD: password};
delete env.DATABASE_URL;
delete env.RESEARCH_DATABASE_URL;
const postgresTool = name => join(pgBin, name + (process.platform === 'win32' ? '.exe' : ''));

await mkdir(outputDir, {recursive: true});
const stage = await mkdtemp(join(outputDir, '.registry-backup-'));
const draft = join(stage, 'registry.dump');
try {
  let snapshots, artifacts;
  try {
    await db.connect();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {rows: [{snapshot}]} = await db.query('SELECT pg_export_snapshot() AS snapshot');
    const {rows} = await db.query(
      'SELECT sha256, snapshot_text FROM public.research_exposure_snapshots ORDER BY sha256 COLLATE "C"'
    );
    assert(rows.length > 0, 'Registry is empty');
    snapshots = rows.map(row => {
      assert.equal(sha(row.snapshot_text), row.sha256, 'Registry revision digest mismatch');
      return {sha256: row.sha256, inventory: JSON.parse(row.snapshot_text).inventory};
    });
    const artifactRows = await db.query(`
      SELECT sha256, octet_length(body) AS bytes, sha256 = encode(sha256(body), 'hex') AS verified
      FROM public.research_artifacts ORDER BY sha256 COLLATE "C"
    `);
    artifacts = artifactRows.rows.map(({sha256, bytes, verified}) => {
      assert(verified, 'Research artifact digest mismatch');
      return {sha256, bytes};
    });
    await run(postgresTool('pg_dump'), [
      '--dbname=' + source.toString(), '--no-password', '--format=custom', '--data-only',
      ...tables.map(table => '--table=public.' + table), '--snapshot=' + snapshot, '--file=' + draft
    ], {env, timeout: 90000});
    await db.query('COMMIT');
  } finally {
    await db.end();
  }

  const restore = postgresTool('pg_restore');
  const {stdout} = await run(restore, ['--list', draft], {timeout: 30000});
  for (const table of tables) {
    assert(stdout.includes('TABLE DATA public ' + table + ' '), 'Missing archived table: ' + table);
  }
  await run(restore, ['--data-only', '--exit-on-error', '--file=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), draft],
    {timeout: 90000});
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(draft)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const inventory = Object.fromEntries(fields.map(field => [field,
    [...new Set(snapshots.flatMap(snapshot => snapshot.inventory[field]))].sort()
  ]));
  const name = 'registry-' + new Date().toISOString().replace(/[:.]/g, '-') + '.dump';
  const manifest = {
    file: name, bytes, sha256: hash.digest('hex'), unionSha256: sha(JSON.stringify(inventory)),
    revisions: snapshots.map(snapshot => snapshot.sha256),
    artifacts,
    totals: Object.fromEntries(fields.map(field => [field, inventory[field].length]))
  };
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(draft, join(outputDir, name));
  await rename(join(stage, 'manifest.json'), join(outputDir, name + '.json'));
  console.log(JSON.stringify(manifest));
} catch (error) {
  const detail = error.stderr?.toString() || error.message;
  console.error(password ? detail.replaceAll(password, '[hidden]') : detail);
  process.exitCode = 1;
} finally {
  await rm(draft, {force: true});
  await rm(join(stage, 'manifest.json'), {force: true});
  await rmdir(stage);
}
