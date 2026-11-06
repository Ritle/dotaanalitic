import {createDatabase} from '../packages/db/dist/index.js';
import {createRetestImportManifest,retestImportInputs,readRetestImportPlan,save} from './lib/v1-retest-import.mjs';
import {executeRetestImportStep} from './lib/v1-retest-import-step.mjs';
const [mode,input,digest,output,...extra]=process.argv.slice(2);
if(!['manifest','prepare','verify','identities','maps','series','export'].includes(mode)||!input||!/^[a-f0-9]{64}$/.test(digest??'')||!output||extra.length){
 console.error('Использование: manifest COLLECTION SHA NEW_MANIFEST | prepare CONFIG SHA NEW_PLAN | verify/identities/maps/series/export PLAN SHA NEW_DIRECTORY');process.exit(2);
}
let db,writesAttempted=false;
try{
 if(mode==='manifest'){
  const manifest=await createRetestImportManifest(input,digest);
  console.log(JSON.stringify({status:'retest_import_manifest_created',output:await save(output,manifest),files:manifest.files.length,providerRequests:0}));
 }else if(mode==='prepare'){
  const {plan}=await retestImportInputs(input,digest);
  console.log(JSON.stringify({status:'retest_import_prepared',output:await save(output,plan),maps:plan.maps.length,accounts:plan.accounts.length,
   provenAccounts:plan.identityReviews.length,unresolvedProfiles:plan.unresolvedProfiles.length,series:plan.providerSeriesIds.length,
   providerRequests:0,evaluationPerformed:false,deployable:false}));
 }else{
  const inputs=await readRetestImportPlan(input,digest);
  if(mode!=='verify'){if(!process.env.DATABASE_URL)throw Error('database_required');db=createDatabase(process.env.DATABASE_URL);}
  const result=await executeRetestImportStep(inputs,db,mode,output,{path:input,sha256:digest},{onWrite:()=>{writesAttempted=true;},onProgress:r=>console.log(JSON.stringify({status:'importing',...r}))});
  console.log(JSON.stringify({status:'retest_import_step_complete',mode,output:result.output,summary:result.report.summary,
   duplicates:result.report.results.filter(r=>r.duplicate).length,providerRequests:0,evaluationPerformed:false,deployable:false,
   ...(mode==='export'?{coverage:result.report.results[0].summary}:{})}));
 }
}catch(e){
 console.error(JSON.stringify({status:'unavailable',code:/^retest_import_[a-z_]+$/.test(e?.message??'')?e.message.toUpperCase():e?.code==='EEXIST'?'OUTPUT_EXISTS':'RETEST_IMPORT_REJECTED',
  writesAttempted,message:e?.message==='retest_import_collection_not_closed'?'Сбор ещё не закрыт. Завершите загрузку и используйте сохранённый итог коллекции.':
   'Этап остановлен. Сохранённые результаты остаются на диске. Проверьте SHA и исходный план; повтор выполняется с новым каталогом.',teamAWinProbability:null}));process.exitCode=1;
}finally{await db?.destroy();}
