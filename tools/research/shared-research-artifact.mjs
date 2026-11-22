import assert from 'node:assert/strict';
import {link, mkdtemp, open, rmdir, unlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import pg from 'pg';
import {sha} from './exposure-ledger-core.mjs';

const maxBytes = 16 * 1024 * 1024;
const [action, digest, path, ...extra] = process.argv.slice(2);
assert(['put', 'get'].includes(action) && /^[a-f0-9]{64}$/.test(digest ?? '') && path && !extra.length,
  'usage: shared-research-artifact put|get SHA256 LOCAL_FILE');
const value = process.env.RESEARCH_DATABASE_URL;
assert(value && URL.canParse(value), 'Valid RESEARCH_DATABASE_URL required');
const url = new URL(value);
assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.pathname.length > 1,
  'Expected an explicit registry database host and name');

async function readInput() {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    assert(info.isFile() && info.size > 0 && info.size <= maxBytes, 'Expected a regular file of at most 16 MiB');
    const bytes = await handle.readFile();
    assert(bytes.length > 0 && bytes.length <= maxBytes, 'Invalid artifact size');
    assert.equal(sha(bytes), digest, 'Artifact does not match the expected SHA-256');
    return bytes;
  } finally {
    await handle.close();
  }
}

async function saveOutput(bytes) {
  const dir = await mkdtemp(join(dirname(path), '.research-download-'));
  const staged = join(dir, 'complete');
  try {
    await writeFile(staged, bytes, {flag: 'wx', mode: 0o600, flush: true});
    await link(staged, path);
  } finally {
    await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(dir);
  }
}

const db = new pg.Client({connectionString: url.toString(), connectionTimeoutMillis: 8000, statement_timeout: 30000});
try {
  const bytes = action === 'put' ? await readInput() : null;
  await db.connect();
  if (action === 'put') {
    const result = await db.query(
      'INSERT INTO public.research_artifacts(sha256, body) VALUES($1, $2) ON CONFLICT (sha256) DO NOTHING',
      [digest, bytes]
    );
    console.log(JSON.stringify({status: result.rowCount === 1 ? 'stored' : 'already_stored', sha256: digest, bytes: bytes.length}));
  } else {
    const {rows} = await db.query('SELECT body FROM public.research_artifacts WHERE sha256=$1', [digest]);
    assert(rows.length === 1, 'No artifact found for this SHA-256');
    const body = rows[0].body;
    assert(Buffer.isBuffer(body) && body.length > 0 && body.length <= maxBytes, 'Invalid stored artifact size');
    assert.equal(sha(body), digest, 'Downloaded artifact does not match the expected SHA-256');
    await saveOutput(body);
    console.log(JSON.stringify({status: 'downloaded', sha256: digest, bytes: body.length}));
  }
} catch (error) {
  if (error.code === 'ERR_ASSERTION') console.error(error.message);
  else console.error('Artifact operation failed: ' + (/^[A-Z0-9_]{2,24}$/.test(error.code ?? '') ? error.code : 'connection_or_query_error'));
  process.exitCode = 1;
} finally {
  await db.end();
}
