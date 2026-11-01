import {writeFile} from 'node:fs/promises';
import {createDatabase,CorpusQualityRepository} from '../packages/db/dist/index.js';
import {CorpusQualityRequestSchema} from '../packages/contracts/dist/index.js';
const [fromAt,toAt,path,...rest]=process.argv.slice(2);
if(!fromAt||!toAt||!path||rest.length){console.error('Использование: report-corpus-quality.mjs from-UTC to-UTC new-report.json');process.exit(2);}
if(!process.env.DATABASE_URL){console.error('Не задан DATABASE_URL.');process.exit(2);}
let db;
try{
  const request=CorpusQualityRequestSchema.parse({fromAt,toAt});db=createDatabase(process.env.DATABASE_URL);
  const report=await new CorpusQualityRepository(db).report(request);
  await writeFile(path,JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({status:report.status,fingerprint:report.fingerprint,summary:report.summary??null,
    reason:report.reason??null,trainingReady:false,deployable:false}));
  if(report.status==='unavailable')process.exitCode=3;
}catch(error){
  console.error(error?.code==='EEXIST'?'Файл отчёта уже существует. Укажите новое имя.':
    error?.message==='future_window'?'Конец периода ещё не наступил. Укажите прошедшее время.':
    'Отчёт качества не создан. Проверьте UTC период, PostgreSQL, миграции и доступ к файлу.');
  process.exitCode=1;
}finally{await db?.destroy();}
