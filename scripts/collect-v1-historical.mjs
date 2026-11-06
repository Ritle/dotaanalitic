import {initializeHistoricalStore,withHistoricalStore,captureHistoricalBatch,historicalStatus,recoverHistoricalLock} from './lib/v1-historical-store.mjs';
import {save} from './lib/v1-historical-protocol.mjs';
const [mode,path,sha,...args]=process.argv.slice(2),digest=v=>/^[a-f0-9]{64}$/.test(v??'');
if(!['init','targets','history','status','recover'].includes(mode)||!path||!digest(sha)||
 (mode==='init'||mode==='status'?args.length!==1:args.length!==0)){
 console.error('Использование: init config SHA new-directory | targets/history/recover directory SHA | status directory SHA new-report');process.exit(2);
}
async function provider(limit){
 const {createDatabase}=await import('../packages/db/dist/index.js');
 const {PostgresProviderBudget}=await import('../packages/ingestion/dist/quota.js');
 const {OpenDotaClient,OpenDotaError}=await import('../packages/ingestion/dist/opendota/client.js');
 const {OpenDotaPlayerHistoryClient}=await import('../packages/ingestion/dist/opendota/player-history.js');
 if(!process.env.DATABASE_URL)throw Error('historical_collection_database_required');
 const limits={rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)};
 if(!Object.values(limits).every(Number.isSafeInteger)||limits.rpm<1||limits.rpm>45||limits.daily<1||limits.daily>3000||limits.monthly<1||limits.monthly>45000)throw Error('historical_collection_quota_configuration');
 const db=createDatabase(process.env.DATABASE_URL),durable=new PostgresProviderBudget(db,limits),httpStatuses={};let requests=0;
 const budget={beforeRequest:async()=>{if(requests>=limit)throw new OpenDotaError('request_budget_exhausted');await durable.beforeRequest();requests++;},observe:(...a)=>{httpStatuses[a[0]]=(httpStatuses[a[0]]??0)+1;return durable.observe(...a);}};
 const client=new OpenDotaClient({apiKey:process.env.OPENDOTA_API_KEY,maxRequests:limit},{budget});
 const discovery=new OpenDotaPlayerHistoryClient(budget,{apiKey:process.env.OPENDOTA_API_KEY});
 return {client,discover:(...a)=>discovery.discover(...a),requests:()=>requests,httpStatuses:()=>httpStatuses,close:()=>db.destroy()};
}
try{
 let result;
 if(mode==='init')result={status:'historical_collection_initialized',output:await initializeHistoricalStore(path,sha,args[0])};
 else if(mode==='recover')result=await recoverHistoricalLock(path,sha);
 else result=await withHistoricalStore(path,sha,async ctx=>{
  if(mode==='status'){const report=await historicalStatus(ctx);return {status:'historical_collection_reviewed',output:await save(args[0],report),summary:report.summary};}
  return captureHistoricalBatch(ctx,mode,provider,p=>{if((p.operations+p.cached)%10===0)console.log(JSON.stringify({status:'collecting',...p}));});
 });
 console.log(JSON.stringify({...result,evaluationPerformed:false,teamAWinProbability:null}));
}catch(e){console.error(JSON.stringify({status:'unavailable',code:/^historical_collection_[a-z_]+$/.test(e?.message??'')?e.message.toUpperCase():e?.code==='EEXIST'?'OUTPUT_OR_LOCK_EXISTS':'HISTORICAL_COLLECTION_REJECTED',
 message:'Сбор остановлен. Успешные ответы сохранены; проверьте SHA, журнал, лимит источника и блокировку процесса. Вероятность не рассчитана.',teamAWinProbability:null}));process.exitCode=1;}
