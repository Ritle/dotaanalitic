/** S1-09 source spike. Single manual run, never scheduled, no database connection. */
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PandaScoreClient,PandaScoreError,PandaIdSchema,auditUpcomingTournament} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),sha=b=>createHash('sha256').update(b).digest('hex');
const valid=args.length===2||args.length===4&&args[2]==='--tournament';
const path=valid&&args[0]==='--out'?resolve(root,args[1]):null,rel=path?relative(root,path):null;
const tournament=args[3];
if(!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json')||tournament!==undefined&&!PandaIdSchema.safeParse(tournament).success){
  console.error('Использование: audit-upcoming-matches.mjs --out reports/new-upcoming.json [--tournament ID].');process.exit(2);
}
try{
  try{await stat(path);console.error('Файл отчёта уже существует. Укажите новое имя.');process.exit(2);}catch(e){if(e.code!=='ENOENT')throw e;}
  let report;
  try{
    const client=new PandaScoreClient({apiToken:process.env.PANDASCORE_API_TOKEN});
    report=await auditUpcomingTournament(client,{tournamentId:tournament});
  }catch(e){
    if(!(e instanceof PandaScoreError))throw e;
    report={schemaVersion:1,mode:'live_pandascore_upcoming_tournament_audit',generatedAt:new Date().toISOString(),
      captureStatus:'blocked',schedule:null,selectedMatch:null,rosters:null,teams:[],coverage:null,
      requests:{attempts:0,httpStatuses:{},transportErrors:{}},errors:[{code:e.code,endpoint:null,status:null,retryAfterMs:null}],
      databaseWrites:0,mapResultsImported:0,trainingExamples:0,trainingReady:false,deployable:false};
  }
  const files=['scripts/audit-upcoming-matches.mjs','packages/ingestion/src/pandascore/client.ts',
    'packages/ingestion/src/pandascore/schemas.ts','packages/ingestion/src/pandascore/audit.ts',
    'packages/ingestion/src/opendota/client.ts','packages/ingestion/dist/pandascore/client.js',
    'packages/ingestion/dist/pandascore/schemas.js','packages/ingestion/dist/pandascore/audit.js','pnpm-lock.yaml'];
  report.code=await Promise.all(files.map(async file=>({file,sha256:sha(await readFile(resolve(root,file)))})));
  const content=JSON.stringify(report,null,2)+'\n',token=process.env.PANDASCORE_API_TOKEN?.trim();
  if(token&&content.includes(token))throw new Error('provider_credential_echo');
  await mkdir(dirname(path),{recursive:true});await writeFile(path,content,{flag:'wx'});
  console.log(JSON.stringify({file:rel.replaceAll('\\','/'),sha256:sha(content),captureStatus:report.captureStatus,
    selectedMatchId:report.selectedMatch?.providerMatchId??null,coverage:report.coverage,requests:report.requests,errors:report.errors}));
  if(report.captureStatus!=='complete')process.exitCode=3;
}catch{console.error('Проверка расписания не выполнена. Проверьте сборку, доступ к API и новый путь отчёта.');process.exitCode=1;}
