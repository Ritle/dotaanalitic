import { createDatabase, V1DataRepository, canonicalContextJson } from '../packages/db/dist/index.js';
import { bounded, save, sha } from './lib/evaluation-discovery-files.mjs';
import { releaseExecutionCode } from './lib/v1-release-files.mjs';
import { importSources, reconcileImportSources } from './lib/v1-import-diagnostics.mjs';
const [input, digest, output, ...extra] = process.argv.slice(2);
let db, stage = 'input';
try {
  if (!input || !/^[a-f0-9]{64}$/.test(digest ?? '') || !output || extra.length) throw Error('input');
  const { data: evidence } = await bounded(input, 65536, digest); stage = 'sources';
  const source = await importSources(evidence); stage = 'database';
  if (!process.env.DATABASE_URL) throw Error('database_required');
  db = createDatabase(process.env.DATABASE_URL);
  const now = new Date().toISOString();
  const dataset = await new V1DataRepository(db, source.syntheticOnly).export({ schemaVersion: 1, profile: 'pre-match-player-elo-data-v1', purpose: 'development_only',
    fromAt: source.context.warmupFromAt, toAt: now, snapshotAt: now, maxMaps: 5000 }, await releaseExecutionCode());
  stage = 'diagnostics'; const report = reconcileImportSources(source, dataset);
  const body = { format: 'managed-import-diagnostics-v1', evidence, dataset, report, providerRequests: 0, modelWrites: 0 };
  stage = 'output'; const saved = await save(output, { ...body, fingerprint: sha(canonicalContextJson(body)) });
  console.log(JSON.stringify({ status: 'import_reconciled', artifactSha256: saved.sha256, coverage: report.coverage,
    snapshotAt: now, providerRequests: 0, teamAWinProbability: null }));
} catch {
  console.error(JSON.stringify({ status: 'unavailable', code: 'IMPORT_RECONCILIATION_REJECTED', stage,
    message: 'Не удалось сверить сохранённые источники с БД. Проверьте файлы, SHA и подключение.', teamAWinProbability: null }));
  process.exitCode = 1;
} finally { await db?.destroy(); }
