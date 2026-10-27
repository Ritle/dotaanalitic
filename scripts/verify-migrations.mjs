import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'packages/db/migrations');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/golden/migrations-v6.sha256.json'), 'utf8'));
const names = fs.readdirSync(dir).filter(x => /^(\d{3})_.+\.sql$/.test(x)).sort();
if (names.length < 5) throw new Error(`Expected >=5 migrations, got ${names.length}`);
for (const [i, n] of names.entries()) {
  const ordinal = Number(n.slice(0, 3));
  if (ordinal !== i + 1) throw new Error(`Non-contiguous migration ordinal: ${n}`);
  const sql = fs.readFileSync(path.join(dir, n), 'utf8');
  if (!sql.trim() || !/\bCREATE\b|\bALTER\b/i.test(sql)) throw new Error(`Empty/no-op migration: ${n}`);
  const digest = crypto.createHash('sha256').update(sql).digest('hex');
  if (baseline[n] && baseline[n] !== digest) throw new Error(`Immutable prior migration changed: ${n}`);
  console.log(`${n} OK ${digest.slice(0, 12)}`);
}
for (const n of Object.keys(baseline)) if (!names.includes(n)) throw new Error(`Missing baseline migration: ${n}`);
console.log(`Validated ${names.length} ordered migration files; historical checksums preserved.`);
