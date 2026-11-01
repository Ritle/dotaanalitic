import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDatabase, ResearchEloRepository, evaluateResearchElo } from '../packages/db/dist/index.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function bounded(path, limit) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw Error('research_file_limit');
    const buffer = Buffer.alloc(limit + 1); let count = 0;
    while (count <= limit) { const part = await handle.read(buffer, count, buffer.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > limit) throw Error('research_file_limit');
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}
const [mode, inputPath, third, fourth, ...extra] = process.argv.slice(2);
if (extra.length || !inputPath || !third || (mode === 'export' ? fourth !== undefined : mode !== 'evaluate' || !fourth || !/^[a-f0-9]{64}$/.test(third))) {
  console.error('Использование: research-elo.mjs export config.json new-export.json | evaluate export.json SHA256 new-report.json'); process.exit(2);
}
let db;
try {
  const bytes = await bounded(inputPath, mode === 'export' ? 65536 : 33554432);
  if (mode === 'evaluate' && digest(bytes) !== third) throw Error('research_source_sha_mismatch');
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  let result;
  if (mode === 'export') {
    if (!process.env.DATABASE_URL) throw Error('research_database_required');
    const paths = ['packages/db/dist/research-elo.js', 'packages/db/dist/research-elo-repository.js',
      'packages/db/dist/identity.js', 'packages/db/dist/identity-repository.js', 'packages/db/dist/outcome-verifier.js',
      'packages/db/dist/dataset-splits.js', 'packages/db/dist/temporal.js', 'packages/contracts/dist/research-elo.js',
      'packages/analytics/dist/elo.js', 'scripts/research-elo.mjs',
      'packages/db/migrations/012_verified_dataset_boundary.sql', 'packages/db/migrations/018_outcome_verifier.sql'];
    const code = await Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(new URL('../' + path, import.meta.url))) })));
    db = createDatabase(process.env.DATABASE_URL);
    result = await new ResearchEloRepository(db).export(input, code);
  } else result = evaluateResearchElo(input);
  const output = JSON.stringify(result, null, 2) + '\n';
  const destination = mode === 'export' ? third : fourth;
  const handle = await open(destination, 'wx');
  try { await handle.writeFile(output, 'utf8'); } finally { await handle.close(); }
  console.log(JSON.stringify({ status: mode === 'export' ? 'research_exported' : result.status,
    fingerprint: result.fingerprint, artifactSha256: digest(output), candidateMaps: result.candidates?.length,
    summary: result.summary, metrics: result.metrics, reason: result.reason,
    trainingReady: false, deployable: false }));
  if (result.status === 'unavailable') process.exitCode = 3;
} catch (error) {
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'RESEARCH_ELO_FAILED',
    message: error?.code === 'EEXIST' ? 'Файл уже существует. Укажите новое имя.' : 'Исследование не выполнено. Проверьте вход, SHA, PostgreSQL и миграции.' }));
  process.exitCode = 1;
} finally { await db?.destroy(); }
