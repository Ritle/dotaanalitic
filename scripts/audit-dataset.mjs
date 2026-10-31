import { readFile, stat } from 'node:fs/promises';
import { createDatabase, DatasetAuditRepository, auditFrozenDatasetContent } from '../packages/db/dist/index.js';
const [mode,value,digest,...rest]=process.argv.slice(2);
if(!['stored','file'].includes(mode)||!value||rest.length||(mode==='file'?!digest:!!digest)) {
  console.error('Использование: audit-dataset.mjs stored dataset-uuid | file export.json expected-sha256');process.exit(2);
}
let db;
try {
  let result;
  if(mode==='stored') {
    if(!process.env.DATABASE_URL) {console.error('Не задан DATABASE_URL.');process.exitCode=2;}
    else {db=createDatabase(process.env.DATABASE_URL);result=await new DatasetAuditRepository(db).audit(value);}
  } else {
    if((await stat(value)).size>64*1024*1024) throw new Error('export_limit');
    result=auditFrozenDatasetContent(await readFile(value,'utf8'),digest);
  }
  if(result) {console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='valid'?0:result.status==='unavailable'?3:1;}
} catch {
  console.error('Проверка датасета не выполнена. Проверьте ID, файл, доступ к PostgreSQL и миграции.');process.exitCode=1;
} finally {await db?.destroy();}
