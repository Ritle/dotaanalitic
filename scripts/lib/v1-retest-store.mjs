import {mkdir,open,readdir,lstat,unlink,link,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RetestAdmissionSchema,RetestOutcomeSchema} from '../../packages/contracts/dist/v1-retest-collection.js';
import {HistoricalStoredRecordSchema} from '../../packages/contracts/dist/v1-historical-collection.js';
import {decodeObservation} from './v1-historical-collection.mjs';
import {loadRetestCollection,collectionInventory,reviewRetestCollection,terminalKey,deadlineReached,
 assessHistoricalMap,decodeHistoricalHistory,hash,order,bounded,sha,fail} from './v1-retest-collection.mjs';
const clock=ctx=>ctx.now?.()??new Date().toISOString(),stamp=body=>({...body,fingerprint:hash(body)});
const same=(a,b)=>hash(a)===hash(b),keyPattern='(?:map-[1-9]\\d{0,18}|history-\\d{3})';
const check=v=>{const {fingerprint,...body}=v;if(hash(body)!==fingerprint)fail('artifact_hash');return v;};
const exists=async p=>{try{await lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
async function directory(p){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())fail('directory');return p;}
async function file(p,limit=33554432){const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())fail('file');return check((await bounded(p,limit)).data);}
/** Fsync before atomic, exclusive publication. A crash leaves a recoverable pending file. */
export async function appendRetestFile(path,value){
 const temp=path+'.'+randomUUID()+'.pending',bytes=JSON.stringify(value)+'\n';
 if(Buffer.byteLength(bytes)>33554432)fail('file_limit');
 const h=await open(temp,'wx');try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
 try{await link(temp,path);}catch(e){if(e.code==='EEXIST'){const prior=await file(path);if(!same(prior,value))throw e;}else throw e;}
 await unlink(temp);return {path,sha256:sha(bytes)};
}
async function recoverPending(ctx,dir){
 for(const name of (await readdir(dir)).filter(n=>n.endsWith('.pending')).sort()){
  const m=name.match(/^(.*\.json)\.[a-f0-9-]{36}\.pending$/);if(!m)fail('pending_name');
  const path=join(dir,name);let value;
  try{value=await file(path);}catch(e){if(e instanceof SyntaxError)continue;throw e;}
  if(value.configSha256!==ctx.configSha)fail('pending_binding');
  const destination=join(dir,m[1]);
  if(await exists(destination)){if(!same(await file(destination),value))fail('pending_conflict');}
  else await link(path,destination);
  await unlink(path);
 }
}
const dirs=['admissions','outcomes','cached','runs','recoveries'];
export async function initializeRetestStore(configPath,configSha,root,now=new Date().toISOString()){
 const ctx=await loadRetestCollection(configPath,configSha);root=resolve(root);
 if(now<ctx.plan.registeredAt||deadlineReached(ctx,now)||ctx.canonical.source.request.snapshotAt>now)fail('initialization_clock');
 await mkdir(root);for(const d of dirs)await mkdir(join(root,d));
 const body=stamp({schemaVersion:2,format:'retest-source-collection-v2',createdAt:now,configPath:resolve(configPath),
  configSha256:configSha,protocolFingerprint:ctx.plan.fingerprint});
 return appendRetestFile(join(root,'collection.json'),body);
}
export async function withRetestStore(root,expectedSha,fn){
 root=await directory(resolve(root));const store=check((await bounded(join(root,'collection.json'),65536,expectedSha)).data);
 if(store.format!=='retest-source-collection-v2'||store.schemaVersion!==2)fail('store_format');
 const ctx=await loadRetestCollection(store.configPath,store.configSha256);
 if(store.protocolFingerprint!==ctx.plan.fingerprint||store.createdAt<ctx.plan.registeredAt||
  store.createdAt>=ctx.plan.collection.collectionDeadline||ctx.canonical.source.request.snapshotAt>store.createdAt)fail('store_binding');
 for(const d of dirs)await directory(join(root,d));
 const lock=await open(join(root,'lock'),'wx');
 try{await lock.writeFile(JSON.stringify({pid:process.pid,at:clock(ctx),storeSha256:expectedSha}));await lock.sync();
  return await fn({...ctx,root,store,storeSha:expectedSha});
 }finally{await lock.close();await unlink(join(root,'lock'));}
}
const nameFor=r=>`${r.key}.${r.ordinal}.json`;
async function entries(ctx,dir,pattern){
 const result=[];for(const name of (await readdir(join(ctx.root,dir))).sort()){
  if(name.endsWith('.pending'))continue;if(!pattern.test(name))fail('journal_inventory');
  const value=await file(join(ctx.root,dir,name));if(value.configSha256!==ctx.configSha)fail('journal_binding');
  result.push({name,value});
 }return result;
}
export async function readRetestState(ctx){
 const closurePath=join(ctx.root,'closure.json');
 // Root publication may also have been interrupted after fsync.
 if(!await exists(closurePath))await recoverPending(ctx,ctx.root);
 const closure=await exists(closurePath)?await file(closurePath):null;
 if(!closure)for(const d of dirs)await recoverPending(ctx,join(ctx.root,d));
 const state={admissions:[],outcomes:[],records:new Map(),runs:[],closure},now=clock(ctx);
 for(const {name,value} of await entries(ctx,'admissions',new RegExp('^'+keyPattern+'\\.[1-3]\\.json$'))){
  const a=RetestAdmissionSchema.parse(value);
  if(name!==nameFor(a)||a.admittedAt<ctx.store.createdAt||a.admittedAt>=ctx.plan.collection.collectionDeadline||a.admittedAt>now)fail('admission_clock');
  state.admissions.push(a);
 }
 const groups=Map.groupBy(state.admissions,a=>a.key);
 for(const group of groups.values()){group.sort((a,b)=>a.ordinal-b.ordinal);
  if(group.some((a,i)=>a.ordinal!==i+1||i>0&&a.admittedAt<group[i-1].admittedAt))fail('attempt_sequence');}
 for(const group of Map.groupBy(state.admissions,a=>a.runId).values())if(group.length>ctx.config.maxRequestsPerRun)fail('run_budget');
 const record=r=>{r=HistoricalStoredRecordSchema.parse(r);check(r);
  if(r.configSha256!==ctx.configSha||r.storedAt<ctx.store.createdAt||r.storedAt<r.observation.source.fetchedAt||
   r.storedAt>=ctx.plan.collection.collectionDeadline||r.storedAt>now||state.records.has(r.key))fail('record_binding');
  decodeObservation(r.observation,r.key.startsWith('map-')?`/matches/${r.key.slice(4)}`:r.observation.source.endpoint,now);state.records.set(r.key,r);return r;};
 for(const {name,value} of await entries(ctx,'outcomes',new RegExp('^'+keyPattern+'\\.[1-3]\\.json$'))){
  const o=RetestOutcomeSchema.parse(value),a=state.admissions.find(a=>a.key===o.key&&a.ordinal===o.ordinal);
  if(name!==nameFor(o)||!a||o.admissionFingerprint!==a.fingerprint||o.completedAt<a.admittedAt||o.completedAt>now||
   o.notBeforeAt!==null&&o.notBeforeAt<o.completedAt)fail('outcome_binding');
  if(o.status==='captured'){
   if(!o.record||o.record.key!==o.key||o.record.origin!=='live'||o.record.cacheRef!==null||o.code!==null||o.completedAt!==o.record.storedAt||
    o.record.observation.source.fetchedAt<a.admittedAt||o.record.observation.source.endpoint!==a.endpoint||
    state.admissions.some(n=>n.key===a.key&&n.ordinal>a.ordinal))fail('capture_binding');
   record(o.record);
  }else if(o.record!==null||o.code===null)fail('failed_outcome');
  state.outcomes.push(o);
 }
 for(const {name,value} of await entries(ctx,'cached',/^map-[1-9]\d{0,18}\.json$/)){
  const r=record(value),ref=ctx.cache.matches.find(m=>m.matchId===r.key.slice(4));
  if(name!==r.key+'.json'||r.origin!=='cache'||!ref||!same(r.cacheRef,{path:ref.path,sha256:ref.sha256})||state.admissions.some(a=>a.key===r.key))fail('cache_binding');
  const input=(await bounded(ref.path,33554432,ref.sha256)).data;
  if(!same(decodeObservation(input,`/matches/${ref.matchId}`,now).observation,r.observation))fail('cache_payload');
 }
 for(const {value} of await entries(ctx,'runs',/^[a-f0-9-]{36}\.json$/)){
  if(value.format!=='retest-collection-run-v2'||value.at>now||value.at<ctx.store.createdAt||
   value.resumeNotBeforeAt!==null&&(typeof value.resumeNotBeforeAt!=='string'||!Number.isFinite(Date.parse(value.resumeNotBeforeAt))))fail('run_binding');
  state.runs.push(value);
 }
 if(closure){
  if(closure.format!=='retest-collection-closure-v2'||closure.configSha256!==ctx.configSha||closure.closedAt>now||
   closure.stateFingerprint!==stateFingerprint(state)||!same(closure.report,reviewRetestCollection(ctx,state,closure.closedAt)))fail('closure_binding');
  if(closure.reason==='deadline'?!deadlineReached(ctx,closure.closedAt):closure.reason!=='all_work_terminal'||!closure.report.collection.terminal)fail('closure_reason');
 }
 collectionInventory(ctx,state,closure?.closedAt??now);return state;
}
const stateFingerprint=state=>hash({admissions:state.admissions.map(a=>a.fingerprint).sort(),outcomes:state.outcomes.map(o=>o.fingerprint).sort(),
 records:[...state.records.values()].map(r=>r.fingerprint).sort(),runs:state.runs.map(r=>r.fingerprint).sort()});
async function finish(ctx,state,a,status,code,httpStatus=null,retryAfterMs=null,record=null){
 if(state.outcomes.some(o=>o.admissionFingerprint===a.fingerprint))return;
 const completedAt=record?.storedAt??clock(ctx),delay=retryAfterMs??(httpStatus===429?60000:httpStatus>=500?1000:null);
 const out=stamp({schemaVersion:2,configSha256:ctx.configSha,key:a.key,ordinal:a.ordinal,admissionFingerprint:a.fingerprint,
  completedAt,status,code,httpStatus,retryAfterMs,notBeforeAt:delay===null?null:new Date(Date.parse(completedAt)+delay).toISOString(),record});
 await appendRetestFile(join(ctx.root,'outcomes',nameFor(a)),out);state.outcomes.push(out);if(record)state.records.set(record.key,record);
}
export async function closeRetestCollection(ctx,state){
 if(state.closure)return state.closure;
 const now=clock(ctx),report=reviewRetestCollection(ctx,state,now);
 if(!deadlineReached(ctx,now)&&!report.collection.terminal)fail('work_not_terminal');
 const closure=stamp({schemaVersion:2,format:'retest-collection-closure-v2',configSha256:ctx.configSha,protocolFingerprint:ctx.plan.fingerprint,
  closedAt:now,reason:deadlineReached(ctx,now)?'deadline':'all_work_terminal',stateFingerprint:stateFingerprint(state),report});
 await appendRetestFile(join(ctx.root,'closure.json'),closure);state.closure=closure;return closure;
}
const safeCode=e=>/^[a-z_]+$/.test(e?.code??'')?e.code:/^retest_collection_[a-z_]+$/.test(e?.message??'')?e.message.slice(18):'source_unavailable';
export async function captureRetestBatch(ctx,phase,createProvider,onProgress=()=>{}){
 if(ctx.config.syntheticOnly)fail('synthetic_live');if(!['targets','history'].includes(phase))fail('phase');
 const state=await readRetestState(ctx);
 if(state.closure)return {status:'collection_closed',summary:state.closure.report.summary,collection:state.closure.report.collection,providerRequests:0};
 // An admitted attempt with no completion is uncertain after a crash; never refund it.
 for(const a of state.admissions)if(!state.outcomes.some(o=>o.admissionFingerprint===a.fingerprint))await finish(ctx,state,a,'interrupted','process_interrupted');
 if(deadlineReached(ctx,clock(ctx))){const c=await closeRetestCollection(ctx,state);return {status:'collection_closed',summary:c.report.summary,collection:c.report.collection,providerRequests:0};}
 const waitUntil=[...state.outcomes.map(o=>o.notBeforeAt),...state.runs.map(r=>r.resumeNotBeforeAt)].filter(Boolean).sort().at(-1);
 if(waitUntil&&waitUntil>clock(ctx))return {status:'cooldown',resumeNotBeforeAt:waitUntil,providerRequests:0};
 let inventory=collectionInventory(ctx,state,clock(ctx));if(phase==='history'&&inventory.jobs===null)fail('target_capture_required');
 const runId=randomUUID();let runtime=null,active=null,current=null,observed=null,requests=0,cached=0,stopped=null,resumeNotBeforeAt=null,serverFailures=0;
 const hooks={beforeRequest:async()=>{
   if(active){await finish(ctx,state,active,'interrupted','response_incomplete',observed?.status??null,observed?.retryAfterMs??null);active=null;}
   const admittedAt=clock(ctx);if(deadlineReached(ctx,admittedAt))fail('deadline');
   if(requests>=ctx.config.maxRequestsPerRun)fail('batch_limit');
   if(terminalKey(ctx,state,current.key,clock(ctx)))fail('attempt_limit');
   active=stamp({schemaVersion:2,configSha256:ctx.configSha,key:current.key,ordinal:state.admissions.filter(a=>a.key===current.key).length+1,
    runId,admittedAt,endpoint:current.endpoint});
   await appendRetestFile(join(ctx.root,'admissions',nameFor(active)),active);state.admissions.push(active);requests++;observed=null;
  },observe:async(status,retryAfterMs)=>{
   observed={status,retryAfterMs};if(status>=400&&active){await finish(ctx,state,active,'failed',status===429?'source_rate_limited':'source_http_error',status,retryAfterMs);active=null;}
  },guard:()=>{if(deadlineReached(ctx,clock(ctx)))fail('deadline');if(requests>=ctx.config.maxRequestsPerRun)fail('batch_limit');
   if(current&&terminalKey(ctx,state,current.key,clock(ctx)))fail('attempt_limit');}};
 const obtain=async(key,job)=>{
  if(state.records.has(key)||terminalKey(ctx,state,key,clock(ctx)))return true;
  if(deadlineReached(ctx,clock(ctx))){stopped='deadline';return false;}
  current={key,endpoint:job?.endpoint??`/matches/${key.slice(4)}`};observed=null;
  const cache=key.startsWith('map-')?ctx.cache.matches.find(r=>r.matchId===key.slice(4)):null;
  if(cache){
   const input=(await bounded(cache.path,33554432,cache.sha256)).data;assessHistoricalMap(ctx,key.slice(4),input,clock(ctx));
   const storedAt=clock(ctx);if(deadlineReached(ctx,storedAt)){stopped='deadline';return false;}
   const r=stamp({schemaVersion:1,configSha256:ctx.configSha,key,storedAt,origin:'cache',cacheRef:{path:cache.path,sha256:cache.sha256},observation:decodeObservation(input,current.endpoint,storedAt).observation});
   await appendRetestFile(join(ctx.root,'cached',key+'.json'),r);state.records.set(key,r);cached++;onProgress({phase,providerRequests:requests,cached,captured:state.records.size});return true;
  }
  if(requests>=ctx.config.maxRequestsPerRun){stopped='batch_limit';return false;}
  try{
   runtime??=await createProvider(ctx.config.maxRequestsPerRun,hooks,ctx.plan.collection.collectionDeadline);
   const input=job?await runtime.discover(job.accounts,job.cutoffAt,job.options,job.page):await runtime.client.getMatchSource(key.slice(4));
   if(!active)fail('missing_admission');
   if(deadlineReached(ctx,clock(ctx))){await finish(ctx,state,active,'late_response','collection_deadline',observed?.status??200);active=null;stopped='deadline';return false;}
   if(job)decodeHistoricalHistory(job,input,clock(ctx));else assessHistoricalMap(ctx,key.slice(4),input,clock(ctx));
   const storedAt=clock(ctx);if(deadlineReached(ctx,storedAt)){await finish(ctx,state,active,'late_response','collection_deadline',observed?.status??200);active=null;stopped='deadline';return false;}
   const record=stamp({schemaVersion:1,configSha256:ctx.configSha,key,storedAt,origin:'live',cacheRef:null,
    observation:decodeObservation(input,current.endpoint,storedAt).observation});
   await finish(ctx,state,active,'captured',null,observed?.status??200,null,record);active=null;serverFailures=0;
   onProgress({phase,providerRequests:requests,cached,captured:state.records.size});return true;
  }catch(e){
   const code=safeCode(e),status=Number.isInteger(e?.status)?e.status:observed?.status??null,delay=Number.isFinite(e?.retryAfterMs)?e.retryAfterMs:observed?.retryAfterMs??null;
   if(active){await finish(ctx,state,active,'failed',code,status,delay);active=null;}
   if(delay!==null)resumeNotBeforeAt=new Date(Date.parse(clock(ctx))+delay).toISOString();
   if(code==='attempt_limit')return true;
   if(status===404)return true;
   if(status>=500&&status<=599){serverFailures++;if(serverFailures<3)return true;}
   stopped=code;return false;
  }
 };
 try{
  if(phase==='targets'){for(const id of ctx.review.ledger.map(r=>r.matchId).sort(order))if(!await obtain('map-'+id))break;}
  else{
   for(const job of inventory.jobs)if(!await obtain(job.key,job))break;
   inventory=collectionInventory(ctx,state,clock(ctx));
   if(!stopped)for(const id of [...inventory.allowedMaps].sort(order))if(!await obtain('map-'+id))break;
  }
  if(active)fail('unsettled_attempt');
  const report=reviewRetestCollection(ctx,state,clock(ctx));
  const run=stamp({schemaVersion:2,format:'retest-collection-run-v2',configSha256:ctx.configSha,runId,at:clock(ctx),phase,
   providerRequests:requests,httpStatuses:runtime?.httpStatuses?.()??{},cached,stopped,resumeNotBeforeAt,summary:report.summary});
  await appendRetestFile(join(ctx.root,'runs',runId+'.json'),run);state.runs.push(run);
  if(report.collection.terminal||deadlineReached(ctx,clock(ctx)))await closeRetestCollection(ctx,state);
  return {status:state.closure?'collection_closed':stopped?'partial':'batch_complete',phase,stopped,resumeNotBeforeAt,providerRequests:requests,cached,
   summary:report.summary,collection:report.collection,evaluationPerformed:false,teamAWinProbability:null};
 }finally{await runtime?.close();}
}
export async function retestStatus(ctx){const state=await readRetestState(ctx);return state.closure?.report??reviewRetestCollection(ctx,state,clock(ctx));}
export async function recoverRetestLock(root,expectedSha){
 root=await directory(resolve(root));const store=(await bounded(join(root,'collection.json'),65536,expectedSha)).data;
 if(store.format!=='retest-source-collection-v2')fail('store_format');
 const lock=(await bounded(join(root,'lock'),4096)).data;
 if(!Number.isSafeInteger(lock.pid)||lock.pid<1||lock.storeSha256!==expectedSha)fail('lock_binding');
 try{process.kill(lock.pid,0);fail('process_alive');}catch(e){if(e?.code!=='ESRCH')throw e;}
 await appendRetestFile(join(root,'recoveries',randomUUID()+'.json'),stamp({configSha256:store.configSha256,at:new Date().toISOString(),lock}));
 await unlink(join(root,'lock'));return {status:'dead_process_lock_removed'};
}
