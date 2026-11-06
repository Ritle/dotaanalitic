import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function findTests(directory) {
 const entries = await readdir(path.join(root, directory), { withFileTypes: true });
 const files = [];
 for (const entry of entries) {
  const relative = path.posix.join(directory, entry.name);
  if (entry.isDirectory()) files.push(...await findTests(relative));
  else if (entry.isFile() && entry.name.endsWith('.integration.test.ts')) files.push(relative);
 }
 return files;
}
const roots = ['apps/api/tests', 'apps/worker/tests', 'packages/db/tests', 'packages/ingestion/tests'];
const files = (await Promise.all(roots.map(findTests))).flat().sort();
if (files.length === 0) throw new Error('No PostgreSQL integration tests found');
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--list')) {
 throw new Error('Usage: node scripts/test-postgres.mjs [--list]');
}
if (process.argv[2] === '--list') {
 console.log(JSON.stringify({ baseline: 'tests/integration/postgres.test.mjs', files }, null, 2));
} else {
 if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required; PostgreSQL tests cannot be skipped');
 function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
 }
 run(['--test', 'tests/integration/postgres.test.mjs']);
 console.log(`Running all ${files.length} PostgreSQL/API integration files in isolated test databases`);
 run(['node_modules/vitest/vitest.mjs', 'run', ...files, '--maxWorkers=1', '--no-file-parallelism', '--testTimeout=30000']);
}
