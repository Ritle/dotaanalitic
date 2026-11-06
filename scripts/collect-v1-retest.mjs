import {initializeRetestStore,withRetestStore,captureRetestBatch,retestStatus,recoverRetestLock,readRetestState,closeRetestCollection} from './lib/v1-retest-store.mjs';
import {save} from './lib/v1-retest-protocol.mjs';
const [mode,path,digest,...args]=process.argv.slice(2),isSha=s=>/^[a-f0-9]{64}$/.test(s??'');
if(!['init','targets','history','status','close','recover'].includes(mode)||!path||!isSha(digest)||
 (mode==='init'||mode==='status'?args.length!==1:args.length!==0)){
 console.error('Использование: init CONFIG SHA NEW_DIRECTORY | targets/history/close/recover DIRECTORY SHA | status DIRECTORY SHA NEW_REPORT');process.exit(2);
}
try{
 let result;
 if(mode==='init')result={status:'retest_collection_initialized',output:await initializeRetestStore(path,digest,args[0])};
 else if(mode==='recover')result=await recoverRetestLock(path,digest);
 else result=await withRetestStore(path,digest,async ctx=>{
  if(mode==='status'){const report=await retestStatus(ctx);return {status:'retest_collection_reviewed',output:await save(args[0],report),summary:report.summary,collection:report.collection};}
  if(mode==='close'){const c=await closeRetestCollection(ctx,await readRetestState(ctx));return {status:'collection_closed',summary:c.report.summary,collection:c.report.collection};}
  const {retestProvider}=await import('./lib/v1-retest-provider.mjs');
  return captureRetestBatch(ctx,mode,retestProvider,p=>{if((p.providerRequests+p.cached)%10===0)console.log(JSON.stringify({status:'collecting',...p}));});
 });
 console.log(JSON.stringify({...result,evaluationPerformed:false,teamAWinProbability:null,deployable:false}));
}catch(e){console.error(JSON.stringify({status:'unavailable',code:/^retest_collection_[a-z_]+$/.test(e?.message??'')?e.message.toUpperCase():e?.code==='EEXIST'?'OUTPUT_OR_LOCK_EXISTS':'RETEST_COLLECTION_REJECTED',
 message:'Сбор остановлен. Сохранённые ответы и попытки остаются в журнале; проверьте лимит, срок, SHA и блокировку процесса.',teamAWinProbability:null}));process.exitCode=1;}
