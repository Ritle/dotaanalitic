import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const requireDb = process.argv.includes('--require-db');
const prod = process.argv.includes('--production');
const results = [];
const check = (name, ok, detail, mandatory = true) => {
  const level = ok ? 'PASS' : mandatory ? 'FAIL' : 'WARN';
  console.log(`${level.padEnd(4)} ${name}: ${detail}`);
  results.push({ level, name });
};
const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node', nodeMajor >= 22, `v${process.versions.node}; requires >=22`);
const pm = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager;
check('Package manager', /^pnpm@\d+/.test(pm), pm);
const lock = fs.existsSync(path.join(root, 'pnpm-lock.yaml'));
check('Lockfile', lock, lock ? 'present' : 'Run corepack pnpm install --lockfile-only then commit pnpm-lock.yaml', strict);
const envPath = path.join(root, prod ? '.env.production' : '.env');
const envExists = fs.existsSync(envPath);
check('Environment', envExists, envExists ? 'local private file present' : `Copy ${prod ? '.env.production.example' : '.env.example'} to ${path.basename(envPath)}`, prod);
if (envExists) {
  const source = fs.readFileSync(envPath, 'utf8');
  for (const key of ['DATABASE_URL', ...(prod ? ['SITE_HOST','POSTGRES_PASSWORD'] : [])]) {
    const found = new RegExp(`^${key}=(.+)$`, 'm').exec(source);
    check(`Env:${key}`, !!found && !/replace-this|change-me|localhost\.invalid/i.test(found[1]), 'set and non-placeholder', prod);
  }
}
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 5000 });
check('Docker Compose', docker.status === 0, docker.status === 0 ? docker.stdout.trim().split('\n')[0] : 'not installed/available', prod || requireDb);
if (requireDb) {
  try {
    const { Client } = await import('pg');
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not provided to process; use node --env-file=.env');
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    const { rows } = await client.query('SELECT current_database() AS db');
    await client.end();
    check('Database connectivity', true, rows[0].db);
  } catch (e) { check('Database connectivity', false, e.message); }
}
const errors = results.filter(x => x.level === 'FAIL').length;
console.log(`Preflight: ${results.length} checks, ${errors} failures`);
if (errors) process.exitCode = 1;
