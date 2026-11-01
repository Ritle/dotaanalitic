import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createDatabase,UpcomingEvidenceRepository} from '../packages/db/dist/index.js';
import {UpcomingEvidenceRequestSchema} from '../packages/contracts/dist/index.js';

const args=process.argv.slice(2);
const usage='Использование: read-upcoming-evidence.mjs provider-match-id cutoff-UTC output.json';
if(args.length!==3){console.error(usage);process.exit(2);}
if(!process.env.DATABASE_URL){console.error('Не задан DATABASE_URL.');process.exit(2);}
let db;
try {
  const request=UpcomingEvidenceRequestSchema.parse({providerMatchId:args[0],cutoffAt:args[1]});
  db=createDatabase(process.env.DATABASE_URL);
  const report=await new UpcomingEvidenceRepository(db).readAsOf(request);
  const path=resolve(args[2]);
  await writeFile(path,JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({status:report.status,reasons:report.reasons,path,
    mapBinding:report.mapBinding,trainingReady:false,deployable:false}));
  if(report.status!=='observed')process.exitCode=3;
}catch(error){
  if(error?.code==='EEXIST')console.error('Файл уже существует. Укажите новое имя для отчёта.');
  else if(error?.name==='ZodError')console.error('Некорректный запрос или формат сохранённых данных. Нужны строковый ID и UTC дата с миллисекундами.');
  else if(error?.code==='future_cutoff')console.error('Момент проверки ещё не наступил. Укажите прошедшее время.');
  else if(error?.code==='invalid_observation')console.error('Нарушена целостность или согласованность снимка источника. Отчёт не создан.');
  else console.error('Не удалось прочитать свидетельства. Проверьте PostgreSQL, миграцию 021 и доступ к файлу.');
  process.exitCode=1;
}finally{await db?.destroy();}
