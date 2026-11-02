import { open } from 'node:fs/promises';
import { createDatabase, ResearchEvaluationJournal } from '../packages/db/dist/index.js';
const [mode, fingerprint, ...rest] = process.argv.slice(2);
if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '') || (mode === 'list' ? rest.length !== 0 :
  !['export', 'export-capture'].includes(mode) || rest.length !== 2 || !/^[1-9]\d{0,9}$/.test(rest[0]))) {
  console.error('Использование: research-journal.mjs list PLAN_FINGERPRINT | export|export-capture PLAN_FINGERPRINT revision new-file.json'); process.exit(2);
}
let db, destination;
try {
  if (!process.env.DATABASE_URL) throw Error('journal_database_required');
  db = createDatabase(process.env.DATABASE_URL); const journal = new ResearchEvaluationJournal(db);
  if (mode === 'list') console.log(JSON.stringify({ status: 'journal_read', planFingerprint: fingerprint, revisions: await journal.list(fingerprint) }));
  else {
    const result = await journal.read(fingerprint, Number(rest[0]));
    destination = await open(rest[1], 'wx');
    await destination.writeFile(mode === 'export' ? result.bytes : result.captureText, 'utf8'); await destination.sync();
    console.log(JSON.stringify({ status: 'journal_exported', revision: result.artifact.journal.revision,
      sha256: mode === 'export' ? result.sha256 : result.artifact.journal.captureSha256, scoringPerformed: false, deployable: false }));
  }
} catch (e) {
  console.error(JSON.stringify({ code: e?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'RESEARCH_JOURNAL_REJECTED',
    message: 'Экспорт или чтение журнала не выполнено. Проверьте БД, fingerprint, номер ревизии и новый путь. Сохранённый результат не изменён.' }));
  process.exitCode = 1;
} finally { await destination?.close(); await db?.destroy(); }
