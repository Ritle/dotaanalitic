import { writeFile } from 'node:fs/promises';
import { createDatabase, V1RuntimeRepository, sql } from '../packages/db/dist/index.js';
import { V1RuntimeRequestSchema } from '../packages/contracts/dist/index.js';
import { bounded } from './lib/evaluation-discovery-files.mjs';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'create' ? args.length !== 2 : mode === 'export' ? args.length !== 2 : mode !== 'get' || args.length !== 1) {
  console.error('Использование: create request.json REQUEST_SHA | get REQUEST_ID | export REQUEST_ID NEW_FILE.json');
  process.exit(2);
}
let db;
try {
  const request = mode === 'create' ? V1RuntimeRequestSchema.parse((await bounded(args[0], 65536, args[1])).data) : null;
  if (!process.env.DATABASE_URL) throw Error('runtime_database_required');
  db = createDatabase(process.env.DATABASE_URL);
  const owners = (await sql`SELECT id FROM app_users LIMIT 2`.execute(db)).rows;
  if (owners.length !== 1) throw Error('runtime_single_owner_required');
  const repo = new V1RuntimeRepository(db), result = request ? await repo.create(owners[0].id, request) : await repo.get(owners[0].id, args[0]);
  if (!result) throw Error('runtime_snapshot_missing');
  if (mode === 'export') await writeFile(args[1], JSON.stringify(result.snapshot), { flag: 'wx', encoding: 'utf8' });
  const s = result.snapshot;
  console.log(JSON.stringify({ id: result.id, sha256: result.sha256, status: s.status, reasons: s.reasons,
    teamAWinProbability: s.teamAWinProbability, cutoffAt: s.cutoffAt, createdAt: s.createdAt, issuedAt: s.issuedAt,
    purpose: s.request.purpose, message: s.status === 'unavailable' ? 'Прогноз недоступен; причины сохранены в снимке.' : 'Условный прогноз одной карты сохранён.' }));
} catch (e) {
  const safe = ['runtime_request_conflict', 'runtime_snapshot_missing', 'runtime_single_owner_required', 'runtime_snapshot_integrity'];
  console.error(JSON.stringify({ status: 'unavailable', code: safe.includes(e?.message) ? e.message.toUpperCase() : 'V1_RUNTIME_REJECTED',
    message: 'Расчёт отклонён. Проверьте ревизию сценария, SHA запроса и локальную сборку. Изменение входов требует нового requestId.' }));
  process.exitCode = 1;
} finally { await db?.destroy(); }
