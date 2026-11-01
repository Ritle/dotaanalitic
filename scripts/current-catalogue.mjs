import {readFile,mkdir,stat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProviderRuntime,prepareCurrentCatalogue} from '../packages/ingestion/dist/index.js';
import {createDatabase,IdentityProvisioner,normalizeReviewedAccounts,canonicalContextJson} from '../packages/db/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),mode=args.shift();
const sha=b=>createHash('sha256').update(b).digest('hex');
function local(file){if(typeof file!=='string')throw new Error('path');const p=resolve(root,file),r=relative(root,p);
  if(!r||r.startsWith('..')||isAbsolute(r)||!r.endsWith('.json'))throw new Error('path');return p;}
async function read(file){const p=local(file);if((await stat(p)).size>16*1024*1024)throw new Error('size');return readFile(p);}
const flags={};let db,runtime,committed=false;
try{
  if(args.length%2)throw new Error('usage');
  for(let i=0;i<args.length;i+=2){if(flags[args[i]])throw new Error('usage');flags[args[i]]=args[i+1];}
  const allowed=mode==='capture'?['--team-ids','--out']:mode==='preview'?['--source','--review','--out']:
    mode==='apply'?['--source','--review','--plan','--sha256','--out']:[];
  if(!allowed.length||allowed.length!==Object.keys(flags).length||allowed.some(f=>!flags[f]))throw new Error('usage');
  const out=local(flags['--out']);await mkdir(dirname(out),{recursive:true});
  // Reserve destination before HTTP/DB work; never overwrite evidence, even with concurrent invocations.
  const handle=await open(out,'wx');
  try{
    let report;
    if(mode==='capture'){
      const ids=flags['--team-ids'].split(',');
      if(ids.length>20||!ids.length||ids.some(id=>!(/^[1-9]\d{0,18}$/.test(id))||BigInt(id)>9223372036854775807n)||new Set(ids).size!==ids.length)throw new Error('team_ids');
      runtime=createProviderRuntime(process.env,Math.min(200,3*(ids.length+1)));
      const registry=await runtime.client.getProPlayers(),teams=[];
      for(const id of ids)teams.push(await runtime.client.getTeam(id));
      const observation=r=>({rawBody:r.rawBody,source:r.source});
      report={schemaVersion:1,mode:'current_catalogue_capture',registry:observation(registry),teams:teams.map(observation)};
      prepareCurrentCatalogue(report,'0'.repeat(64),new Date().toISOString());
    }else{
      const [sourceBytes,reviewBytes]=await Promise.all([read(flags['--source']),read(flags['--review'])]);
      const review=normalizeReviewedAccounts(JSON.parse(reviewBytes));
      if(review.policyVersion!=='reviewed-current-catalogue-v1')throw new Error('review_policy');
      const prepared=prepareCurrentCatalogue(JSON.parse(sourceBytes),sha(sourceBytes),review.reviewedAt);
      if(canonicalContextJson(normalizeReviewedAccounts(prepared.review))!==canonicalContextJson(review))throw new Error('review_binding');
      let plan;
      if(mode==='apply'){
        const planBytes=await read(flags['--plan']);if(sha(planBytes)!==flags['--sha256'])throw new Error('plan_hash');
        plan=JSON.parse(planBytes);
        if(plan.mode!=='current_catalogue_preview'||plan.review.sha256!==sha(reviewBytes)||plan.source.sha256!==sha(sourceBytes))throw new Error('plan_binding');
      }
      if(!process.env.DATABASE_URL)throw new Error('database_configuration');
      db=createDatabase(process.env.DATABASE_URL);const service=new IdentityProvisioner(db);
      let result;
      if(mode==='preview')result={plan:await service.preview(review),databaseWrites:0};
      else {const applied=await service.apply(review,plan.plan.fingerprint);committed=true;result={...applied,
        databaseWrites:applied.playersCreated+applied.accountProofsAdded+applied.aliasesAdded+(applied.teamsCreated??0)};}
      report={schemaVersion:1,mode:'current_catalogue_'+mode,generatedAt:new Date().toISOString(),
        source:{file:flags['--source'],sha256:sha(sourceBytes)},review:{file:flags['--review'],sha256:sha(reviewBytes)},
        ...(mode==='apply'?{planInput:{file:flags['--plan'],sha256:flags['--sha256']}}:{}),...result,
        sourceRowCount:prepared.sourceRowCount,reportedMemberships:prepared.reportedMemberships,warnings:prepared.warnings,
        networkRequests:0,verifiedMapLineups:0,trainingExamples:0,trainingReady:false,deployable:false};
    }
    const body=JSON.stringify(report,null,2)+'\n';await handle.writeFile(body);
    console.log(JSON.stringify({file:relative(root,out).replaceAll('\\','/'),sha256:sha(body),status:report.status??report.plan?.status??'captured',
      databaseWrites:report.databaseWrites??0,...(runtime?{requests:runtime.client.requestStats}:{})}));
  }finally{await handle.close();}
}catch(e){console.error(JSON.stringify({error:committed?'catalogue_committed_report_failed':'catalogue_failed',code:e.code??(e.name==='ZodError'?'invalid_source_or_review':'invalid_input'),
  fields:e.fields??[],message:committed?'Каталог записан, но отчёт сохранить не удалось. Проверьте состояние БД перед повтором.':
    'Импорт не выполнен. Используйте capture --team-ids ID,ID --out FILE; preview --source FILE --review FILE --out FILE; apply --source FILE --review FILE --plan FILE --sha256 SHA --out FILE. Пути JSON внутри проекта.',committed}));process.exitCode=1;
}finally{await runtime?.close();await db?.destroy();}
