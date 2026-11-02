import { open, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDatabase, V1DataRepository, verifyV1Data } from '../packages/db/dist/index.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function bounded(path, limit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('v1_file_limit');
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) { const part = await file.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > limit) throw Error('v1_file_limit');
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}
async function codeManifest() {
  const files = ['scripts/prepare-v1-data.mjs', 'package.json', 'pnpm-lock.yaml'];
  for (const directory of ['packages/contracts/dist', 'packages/db/dist', 'packages/db/migrations']) {
    for (const name of (await readdir(new URL('../' + directory + '/', import.meta.url))).sort())
      if (name.endsWith('.js') || name.endsWith('.sql')) files.push(directory + '/' + name);
  }
  return Promise.all(files.sort().map(async path => ({ path, sha256: digest(await readFile(new URL('../' + path, import.meta.url))) })));
}
const [mode, inputPath, third, ...extra] = process.argv.slice(2);
if (extra.length || !inputPath || (mode === 'preview' ? third !== undefined : mode === 'export' ? !third :
  mode === 'verify' ? !third || !/^[a-f0-9]{64}$/.test(third) : true)) {
  console.error('Использование: prepare-v1-data.mjs preview config.json | export config.json new-dataset.json | verify dataset.json SHA256');
  process.exit(2);
}
let db;
try {
  const bytes = await bounded(inputPath, mode === 'verify' ? 67108864 : 65536);
  if (mode === 'verify' && digest(bytes) !== third) throw Error('v1_file_sha_mismatch');
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  let artifact;
  if (mode === 'verify') artifact = verifyV1Data(input);
  else {
    if (!process.env.DATABASE_URL) throw Error('v1_database_required');
    db = createDatabase(process.env.DATABASE_URL);
    artifact = await new V1DataRepository(db).export(input, await codeManifest());
  }
  const output = JSON.stringify(artifact, null, 2) + '\n';
  if (Buffer.byteLength(output) > 67108864) throw Error('v1_file_limit');
  if (mode === 'export') {
    const file = await open(third, 'wx');
    try { await file.writeFile(output, 'utf8'); } finally { await file.close(); }
  }
  console.log(JSON.stringify({ status: mode === 'verify' ? 'verified' : artifact.report.status,
    profile: artifact.report.profile, fingerprint: artifact.fingerprint,
    artifactSha256: mode === 'verify' ? digest(bytes) : digest(output), summary: artifact.report.summary,
    reason: artifact.report.reason, evaluation: 'not_performed', trainingReady: false, deployable: false,
    teamAWinProbability: null }, null, 2));
  if (artifact.report.status === 'unavailable') process.exitCode = 3;
} catch (error) {
  const allowed = ['v1_inventory_limit', 'v1_fact_inventory_limit', 'v1_snapshot_in_future', 'v1_file_limit',
    'v1_file_sha_mismatch', 'v1_dataset_fingerprint_mismatch', 'v1_dataset_replay_mismatch', 'v1_synthetic_evidence_forbidden'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    allowed.includes(error?.message) ? error.message.toUpperCase() : 'V1_DATA_FAILED',
    message: error?.code === 'EEXIST' ? 'Файл уже существует. Укажите новое имя.' :
      'Подготовка V1 не выполнена. Проверьте конфиг, SHA, лимит выборки, PostgreSQL и миграции.' }));
  process.exitCode = 1;
} finally { await db?.destroy(); }
