import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const migrationsDir = path.join(root, 'packages/db/migrations');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  // Serializes concurrent migration runners on a single PostgreSQL database.
  await client.query('SELECT pg_advisory_lock(42133721)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await fs.readdir(migrationsDir)).filter((s) => /^\d+_.*\.sql$/.test(s)).sort();
  for (const filename of files) {
    const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE filename = $1', [filename]);
    if (rows.length > 0) {
      if (rows[0].checksum !== checksum) throw new Error(`Migration changed after apply: ${filename}`);
      console.log(`SKIP ${filename}`);
      continue;
    }
    // Run schema statements and ledger insert in ONE transaction, even if a
    // migration source includes legacy top-level BEGIN/COMMIT wrappers.
    const body = sql.replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
    await client.query('BEGIN');
    try {
      await client.query(body);
      await client.query('INSERT INTO schema_migrations(filename,checksum) VALUES ($1,$2)', [filename, checksum]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log(`APPLIED ${filename}`);
  }
} finally {
  try { await client.query('SELECT pg_advisory_unlock(42133721)'); } finally { await client.end(); }
}
