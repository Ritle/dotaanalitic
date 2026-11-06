import {mkdir,open,readdir,lstat,unlink,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HistoricalStoredRecordSchema,HistoricalFailureSchema} from '../../packages/contracts/dist/v1-historical-collection.js';
import {bounded,save,sha} from './v1-historical-protocol.mjs';
import {loadHistoricalCollection,decodeObservation,assessHistoricalMap,historicalHistoryJobs,decodeHistoricalHistory,reviewHistoricalCollection,hash,fail,order} from './v1-historical-collection.mjs';
const clock=()=>new Date().toISOString();
async function directory(path){const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail('directory');return path;}
export async function initializeHistoricalStore(configPath,configSha,root,now=clock()){
 const ctx=await loadHistoricalCollection(configPath,configSha);root=resolve(root);
 if(now<ctx.plan.registeredAt||now<ctx.review.checkedAt)fail('clock');
 await mkdir(root);await mkdir(join(root,'records'));await mkdir(join(root,'attempts'));
 return save(join(root,'collection.json'),{schemaVersion:1,format:'historical-source-collection-v1',createdAt:now,
  configPath:resolve(configPath),configSha256:configSha,protocolFingerprint:ctx.plan.fingerprint});
}
export async function withHistoricalStore(root,expectedSha,fn){
 root=await directory(resolve(root));const plan=(await bounded(join(root,'collection.json'),65536,expectedSha)).data;
 if(plan.format!=='historical-source-collection-v1')fail('store_format');
 const ctx=await loadHistoricalCollection(plan.configPath,plan.configSha256);
 if(ctx.plan.fingerprint!==plan.protocolFingerprint)fail('store_binding');
 await directory(join(root,'records'));await directory(join(root,'attempts'));
 const lock=await open(join(root,'lock'),'wx');
 try{await lock.writeFile(JSON.stringify({pid:process.pid,at:clock()}));return await fn({...ctx,root,store:plan});}
 finally{await lock.close();await unlink(join(root,'lock'));}
}
export async function readHistoricalRecords(ctx){
 const records=new Map();
 const names=(await readdir(join(ctx.root,'records'))).sort();
 const validate=record=>{const {fingerprint,...body}=record;
  if(record.configSha256!==ctx.configSha||hash(body)!==fingerprint||record.storedAt<record.observation.source.fetchedAt||record.storedAt>clock())fail('record_binding');
  decodeObservation(record.observation,record.key.startsWith('map-')?`/matches/${record.key.slice(4)}`:record.observation.source.endpoint,clock());return record;};
 for(const name of names){
  if(/^\.(?:map-\d+|history-\d{3})-[a-f0-9-]+\.pending$/.test(name))continue;
  if(!/^(?:map-[1-9]\d{0,18}|history-\d{3})\.json$/.test(name))fail('record_inventory');
  const stat=await lstat(join(ctx.root,'records',name));if(!stat.isFile()||stat.isSymbolicLink())fail('record_file');
  const record=HistoricalStoredRecordSchema.parse((await bounded(join(ctx.root,'records',name),33554432)).data);
  if(record.key+'.json'!==name)fail('record_binding');records.set(record.key,validate(record));
 }
 for(const name of names.filter(n=>n.endsWith('.pending'))){
  const stat=await lstat(join(ctx.root,'records',name));if(!stat.isFile()||stat.isSymbolicLink())fail('record_file');
  let data;try{data=(await bounded(join(ctx.root,'records',name),33554432)).data;}catch(e){if(e instanceof SyntaxError)continue;throw e;}
  const record=validate(HistoricalStoredRecordSchema.parse(data));
  if(!name.startsWith('.'+record.key+'-'))fail('record_binding');
  if(records.has(record.key)){if(records.get(record.key).fingerprint!==record.fingerprint)fail('pending_conflict');continue;}
  await rename(join(ctx.root,'records',name),join(ctx.root,'records',record.key+'.json'));records.set(record.key,record);
 }
 return records;
}
async function publish(ctx,key,input,origin,cacheRef){
 const {observation}=decodeObservation(input,key.startsWith('map-')?`/matches/${key.slice(4)}`:input.source.endpoint,clock());
 const body={schemaVersion:1,configSha256:ctx.configSha,key,storedAt:clock(),origin,cacheRef,observation};
 const record={...body,fingerprint:hash(body)},temp=join(ctx.root,'records',`.${key}-${randomUUID()}.pending`);
 const handle=await open(temp,'wx');try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}finally{await handle.close();}
 await rename(temp,join(ctx.root,'records',key+'.json'));return record;
}
export function validateHistoricalInventory(ctx,records,now=clock()){
 const maps=[...records.entries()].filter(([key])=>key.startsWith('map-')).map(([key,r])=>assessHistoricalMap(ctx,key.slice(4),r.observation,now));
 const jobs=historicalHistoryJobs(ctx,maps),allowedMaps=new Set(ctx.review.ledger.map(r=>r.matchId));
 for(const [key,r] of records)if(key.startsWith('history-')){
  const job=jobs?.find(j=>j.key===key);if(!job)fail('history_scope');
  for(const row of decodeHistoricalHistory(job,r.observation,now).rows)allowedMaps.add(row.match_id);
 }
 if(allowedMaps.size>ctx.plan.request.maxInventoryMaps)fail('inventory_limit');
 for(const a of maps)if(!allowedMaps.has(a.matchId))fail('map_scope');
 return {maps,jobs,allowedMaps};
}
export async function historicalDeferredSources(ctx,records){
 const byKey=new Map();
 for(const name of await readdir(join(ctx.root,'attempts'))){
  if(!/^[a-f0-9-]{36}\.json$/.test(name))fail('attempt_inventory');
  const value=(await bounded(join(ctx.root,'attempts',name),65536)).data;if(!value.key)continue;
  const failure=HistoricalFailureSchema.parse(value);if(failure.at>clock())fail('attempt_clock');
  if(failure.code!=='source_http_error'||!failure.key.startsWith('map-')||records.has(failure.key))continue;
  const list=byKey.get(failure.key)??[];list.push(failure);byKey.set(failure.key,list);
 }
 for(const [key,list] of byKey){list.sort((a,b)=>a.at.localeCompare(b.at));const status=list.at(-1).httpStatus;
  if(!(status===404||status>=500&&list.length>=2))byKey.delete(key);
 }
 return byKey;
}
/** One bounded batch, lazy provider creation, successful receipts reused before any HTTP. */
export async function captureHistoricalBatch(ctx,phase,createProvider,onProgress=()=>{}){
 if(ctx.config.syntheticOnly)fail('synthetic_live');
 if(!['targets','history'].includes(phase))fail('phase');
 const records=await readHistoricalRecords(ctx);ctx.deferred=await historicalDeferredSources(ctx,records);
 let state=validateHistoricalInventory(ctx,records),runtime=null,operations=0,cached=0,stopped=null,consecutiveServerFailures=0;
 const failedMaps=[];
 const cache=new Map(ctx.cache.matches.map(r=>[r.matchId,r]));
 const obtain=async(key,job)=>{
  if(records.has(key))return true;
  if(ctx.deferred.has(key))return true;
  if(operations>=ctx.config.maxRequestsPerRun){stopped='batch_limit';return false;}
  let input,origin='live',ref=null;
  if(key.startsWith('map-')&&cache.has(key.slice(4))){const c=cache.get(key.slice(4));ref={path:c.path,sha256:c.sha256};input=(await bounded(c.path,33554432,c.sha256)).data;origin='cache';}
  else{
   runtime??=await createProvider(ctx.config.maxRequestsPerRun);operations++;
   try{input=job?await runtime.discover(job.accounts,job.cutoffAt,job.options,job.page):await runtime.client.getMatchSource(key.slice(4));}
   catch(e){stopped=typeof e?.code==='string'&&/^[a-z_]+$/.test(e.code)?e.code:'source_unavailable';
    await save(join(ctx.root,'attempts',randomUUID()+'.json'),{key,at:clock(),code:stopped,httpStatus:Number.isInteger(e?.status)?e.status:null,retryAfterMs:Number.isFinite(e?.retryAfterMs)?e.retryAfterMs:null});
    if(!job&&e?.code==='source_http_error'&&(e.status===404||e.status>=500&&e.status<=599)){
     failedMaps.push(key);consecutiveServerFailures=e.status===404?0:consecutiveServerFailures+1;
     if(consecutiveServerFailures<3){stopped=null;return true;}
    }
    return false;}
  }
  if(job)decodeHistoricalHistory(job,input,clock());else assessHistoricalMap(ctx,key.slice(4),input,clock());
  const record=await publish(ctx,key,input,origin,ref);records.set(key,record);if(origin==='cache')cached++;
  consecutiveServerFailures=0;
  onProgress({phase,captured:records.size,operations,cached});return true;
 };
 try{
  if(phase==='targets')for(const id of ctx.review.ledger.map(r=>r.matchId).sort(order)){if(!await obtain('map-'+id))break;}
  else{
   if(!state.jobs)fail('target_capture_required');
   for(const job of state.jobs){if(!await obtain(job.key,job))break;}
   state=validateHistoricalInventory(ctx,records);
   if(!stopped)for(const id of [...state.allowedMaps].sort(order)){if(!await obtain('map-'+id))break;}
  }
  ctx.deferred=await historicalDeferredSources(ctx,records);validateHistoricalInventory(ctx,records);
  if(!stopped&&failedMaps.length)stopped='map_sources_unavailable';
  const report=reviewHistoricalCollection(ctx,records,clock());
  const receipt={status:stopped?'partial':ctx.deferred.size?'batch_complete_with_unavailable':'batch_complete',phase,stopped,operations,cached,providerRequests:runtime?.requests()??0,httpStatuses:runtime?.httpStatuses?.()??null,summary:report.summary,evaluationPerformed:false,teamAWinProbability:null};
  await save(join(ctx.root,'attempts',randomUUID()+'.json'),{...receipt,at:clock()});return receipt;
 }finally{await runtime?.close();}
}
export async function historicalStatus(ctx){const records=await readHistoricalRecords(ctx);ctx.deferred=await historicalDeferredSources(ctx,records);validateHistoricalInventory(ctx,records);return reviewHistoricalCollection(ctx,records,clock());}
export async function recoverHistoricalLock(root,expectedSha){
 root=await directory(resolve(root));await bounded(join(root,'collection.json'),65536,expectedSha);
 const lock=(await bounded(join(root,'lock'),4096)).data;
 if(!Number.isSafeInteger(lock.pid)||lock.pid<1)fail('lock_invalid');
 try{process.kill(lock.pid,0);fail('process_alive');}catch(e){if(e?.code!=='ESRCH')throw e;}
 await unlink(join(root,'lock'));return {status:'dead_process_lock_removed'};
}
