import {writeFile} from 'node:fs/promises';
import {createDatabase,V1JournalRepository,sql} from '../packages/db/dist/index.js';
import {V1JournalCurrentRequestSchema} from '../packages/contracts/dist/index.js';
import {bounded} from './lib/evaluation-discovery-files.mjs';
const [mode,...args]=process.argv.slice(2);
if(mode==='create'?args.length!==2:mode==='export'?args.length!==2:mode!=='get'||args.length!==1){
  console.error('Использование: create request.json SHA | get REQUEST_ID | export REQUEST_ID NEW_FILE.json');process.exit(2);
}
let db;
try {
  const request=mode==='create'?V1JournalCurrentRequestSchema.parse((await bounded(args[0],65536,args[1])).data):null;
  if(!process.env.DATABASE_URL)throw Error('journal_database_required');db=createDatabase(process.env.DATABASE_URL);
  const owners=(await sql`SELECT id FROM app_users WHERE is_active LIMIT 2`.execute(db)).rows;
  if(owners.length!==1)throw Error('journal_owner_required');
  const repository=new V1JournalRepository(db),result=request?await repository.create(owners[0].id,request):await repository.get(owners[0].id,args[0]);
  if(mode==='export')await writeFile(args[1],JSON.stringify(result,null,2)+'\n',{flag:'wx',encoding:'utf8'});
  const r=result.report;
  console.log(JSON.stringify({revision:result.revision,sha256:result.sha256,capturedAt:r.capturedAt,requestId:r.request.requestId,
    counts:r.summary.counts,metrics:r.summary.metrics,matchedLineupMetrics:r.summary.matchedLineupMetrics,warnings:r.summary.warnings,
    message:'Отчёт журнала сохранён. N считает основные прогнозы отдельных карт; это не проверка качества модели для активации.'}));
}catch(e){console.error(JSON.stringify({status:'unavailable',code:['journal_request_conflict','journal_inventory_limit','journal_inventory_bytes_limit',
  'journal_report_bytes_limit','journal_integrity','NOT_FOUND'].includes(e?.message)?e.message:'V1_JOURNAL_REJECTED',
  message:'Отчёт не создан или не прочитан. Проверьте SHA запроса, локальную сборку и лимит полного журнала.'}));process.exitCode=1;}
finally{await db?.destroy();}
