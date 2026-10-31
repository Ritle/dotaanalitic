import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createDatabase, DatasetBuilder } from '../packages/db/dist/index.js';
import { DatasetBuildRequestSchema } from '../packages/contracts/dist/index.js';

const usage='Использование: prepare-dataset.mjs preview config.json | build config.json | export dataset-uuid output.json';
const args=process.argv.slice(2),mode=args[0];
if(!['preview','build','export'].includes(mode)||args.length!==(mode==='export'?3:2)) {
  console.error(usage);process.exit(2);
}
if(!process.env.DATABASE_URL) {console.error('Не задан DATABASE_URL.');process.exit(2);}
const root=fileURLToPath(new URL('../',import.meta.url));
// Hash the actual executable boundaries (including uncommitted changes), not just HEAD.
async function executableRevision() {
  const files=['scripts/prepare-dataset.mjs','pnpm-lock.yaml','package.json',
    'packages/db/package.json','packages/contracts/package.json'];
  for(const dir of ['packages/contracts/dist','packages/db/dist','packages/db/migrations']) {
    for(const file of (await readdir(join(root,dir))).sort()) if(file.endsWith('.js')||file.endsWith('.sql')) files.push(dir+'/'+file);
  }
  const digest=createHash('sha256');
  for(const file of files.sort()) {digest.update(file+'\0');digest.update(await readFile(join(root,file)));digest.update('\0');}
  return 'executed-source-sha256:'+digest.digest('hex');
}
let db;
try {
  let request;
  if(mode!=='export') {
    if((await stat(args[1])).size>65536) throw new Error('invalid_request');
    request=DatasetBuildRequestSchema.parse(JSON.parse(await readFile(args[1],'utf8')));
  }
  db=createDatabase(process.env.DATABASE_URL);
  const builder=new DatasetBuilder(db);
  if(mode==='export') {
    const frozen=await builder.exportFrozen(args[1]);
    const path=resolve(args[2]);
    // Exact PostgreSQL canonical bytes: no JSON reserialization and no trailing newline.
    await writeFile(path,frozen.content,{encoding:'utf8',flag:'wx'});
    process.stdout.write(JSON.stringify({status:'exported',path,fingerprint:frozen.fingerprint})+'\n');
  } else {
    const result=await builder.prepare(request,await executableRevision(),mode==='build');
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.status==='unavailable') process.exitCode=3;
  }
} catch(error) {
  if(error?.code==='EEXIST') console.error('Файл экспорта уже существует. Укажите новое имя.');
  else if(error?.name==='ZodError'||error instanceof SyntaxError||error?.message==='invalid_request')
    console.error('Некорректный конфиг: нужны UTC даты с миллисекундами, упорядоченные окна и явная сторона A.');
  else if(error?.message==='dataset_fingerprint_mismatch') console.error('SHA-256 датасета не совпадает. Экспорт отменён.');
  else if(error?.message==='frozen_dataset_not_found') console.error('Замороженный датасет не найден.');
  else console.error('Подготовка датасета не выполнена. Проверьте PostgreSQL, миграцию 018 и доступ к файлам. Изменения транзакции отменены.');
  process.exitCode=1;
} finally {await db?.destroy();}
