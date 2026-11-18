import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
import {PostgresProviderBudget,OpenDotaPlayerHistoryClient,OpenDotaError,PlayerHistoryRowsSchema,
 playerHistoryQuery,validatePlayerHistoryPage} from '../../packages/ingestion/dist/index.js';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const proposalPath='docs/evidence/s3-04-history-discovery-proposal.json';
const auditPath='.tools/s304-history-gaps-r1.json',capturePath='.tools/s304-dataset-capture-final.json';
const frozenManifestPath='.tools/s304-eval-r1/manifest.json';
const safe=p=>{const x=resolve(root,p),r=relative(root,x);if(!r||r.startsWith('..')||r.includes(':'))throw Error('outside_workspace');return x;};
const local=p=>relative(root,p).replaceAll('\\','/');
const immutable=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const endpoint=q=>'/explorer?'+new URLSearchParams({sql:playerHistoryQuery(q.accountIds,q.cutoffAt,q.options,q.page)});
const Response=z.object({rows:PlayerHistoryRowsSchema,err:z.null()});
const errorCode=e=>e instanceof OpenDotaError?e.code:'local_or_validation_error';
const limits=()=>({rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)});

export function boundedBudget(shared,state){
 return {beforeRequest:async()=>{if(state.attempts>=18||state.queryAttempts>=2)throw new OpenDotaError('request_budget_exhausted');await shared.beforeRequest();},
  observe:(...args)=>shared.observe(...args)};
}

export function validatePlan(plan,audit){
 if(plan.status!=='draft_not_registered_not_executed'||plan.deployable!==false||plan.purpose!=='diagnostic_discovery_only'||
  plan.queries.length!==9||plan.accounts.length!==20||plan.budget.maxHttpAttemptsIncludingRetries!==18||
  plan.budget.maxAccountMapRows!==200||!plan.noAutomaticPagination||
  ['detailRequests','profileRequests','leagueCatalogueRequests','heroCatalogueRequests','businessWrites'].some(k=>plan.budget[k]!==0))throw Error('scope_changed');
 if(digest(plan.accounts)!==digest(audit.collectionProposal.accountIds)||digest(plan.deferredAccounts)!==digest(audit.collectionProposal.deferredAccountIds)||
  new Set(plan.accounts).size!==20||digest(plan.queries.flatMap(q=>q.accountIds))!==digest(plan.accounts))throw Error('accounts_changed');
 for(const q of plan.queries){
  endpoint(q);
  if(q.options.windowDays!==730||q.options.maxMaps!==10||q.page.limit!==10||Object.keys(q.page.cursors).length||q.maxHttpAttemptsIncludingRetry!==2||
   q.fromAt!==new Date(Date.parse(q.cutoffAt)-730*86400000).toISOString()||
   q.accountIds.some(id=>audit.accounts.find(a=>a.accountId===id)?.earliestCutoffAt!==q.cutoffAt))throw Error('query_changed');
 }
 return plan;
}

export function validateObservation(observation,q){
 const parsed=Response.parse(JSON.parse(observation.rawBody));
 if(sha(observation.rawBody)!==observation.source.payloadSha256||digest(parsed)!==digest(observation.data)||
  observation.source.provider!=='opendota'||observation.source.endpoint!==endpoint(q)||observation.source.knownAt!==null||
  !Number.isFinite(Date.parse(observation.source.fetchedAt)))throw Error('receipt_binding');
 validatePlayerHistoryPage(parsed.rows,q.accountIds,q.cutoffAt,q.options,q.page);
 return parsed.rows;
}

/** Stop after first unavailable response. Missing requests remain unknown, never zero-match results. */
export async function collectQueries(plan,discover,save){
 const records=[];let stopped=false;
 for(const [index,q] of plan.queries.entries()){
  let record={index,status:'not_attempted',reason:'earlier_query_unavailable'};
  if(!stopped){try{const observation=await discover(q,index);validateObservation(observation,q);record={index,status:'observed',observation};}
   catch(e){record={index,status:'unavailable',reason:errorCode(e),retryAfterMs:e instanceof OpenDotaError?e.retryAfterMs:null};stopped=true;}}
  await save(record);records.push(record);
 }
 return records;
}

export function summarizeDiscovery(plan,records,knownIds=[]){
 if(records.length!==plan.queries.length||records.some((r,i)=>r.index!==i))throw Error('record_set');
 let stopped=false;for(const r of records){
  if(!['observed','unavailable','not_attempted'].includes(r.status)||stopped&&r.status!=='not_attempted'||!stopped&&r.status==='not_attempted')throw Error('record_sequence');
  if(r.status==='unavailable')stopped=true;
 }
 const accounts=[],maps=new Map(),known=new Set(knownIds);let rowCount=0;
 for(const [i,q] of plan.queries.entries()){
  const record=records[i],rows=record.status==='observed'?validateObservation(record.observation,q):null;
  for(const accountId of q.accountIds){const selected=rows?.filter(r=>r.account_id===accountId);
   accounts.push({accountId,queryIndex:i,status:record.status,rows:selected?.length??null,
    sourceLimitReached:selected?selected.length===q.page.limit:null,remoteCompleteness:'unknown'});}
  for(const row of rows??[]){rowCount++;const m=maps.get(row.match_id)??{matchId:row.match_id,knownInFrozenCapture:known.has(row.match_id),observations:[],conflicts:[]};
   for(const prior of m.observations){
    for(const key of ['start_time','duration','leagueid','radiant_win'])if(prior.row[key]!==row[key])m.conflicts.push('MAP_'+key.toUpperCase()+'_CONFLICT');
    if(prior.row.player_slot===row.player_slot&&prior.row.account_id!==row.account_id)m.conflicts.push('PLAYER_SLOT_CONFLICT');
   }
   m.observations.push({queryIndex:i,row});m.conflicts=[...new Set(m.conflicts)].sort();maps.set(row.match_id,m);
  }
 }
 if(rowCount>plan.budget.maxAccountMapRows)throw Error('row_budget');
 const list=[...maps.values()].sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1);
 return {status:records.every(r=>r.status==='observed')?'completed_discovery':'partial_discovery',accounts,
  counts:{queries:records.length,observedQueries:records.filter(r=>r.status==='observed').length,
   accountMapRows:rowCount,uniqueMaps:list.length,knownInFrozenCapture:list.filter(m=>m.knownInFrozenCapture).length,
   newToFrozenCapture:list.filter(m=>!m.knownInFrozenCapture).length,conflictedMaps:list.filter(m=>m.conflicts.length).length},maps:list,
  eligibility:'candidates_only_not_verified_training_maps',trainingPerformed:false,deployable:false};
}

async function codeHashes(){
 const old=(await boundedJson(safe(frozenManifestPath))).value.code;
 for(const e of old)if(sha(await readFile(safe(e.path)))!==e.sha256)throw Error('frozen_code_changed');
 const paths=new Set(old.map(e=>e.path));
 async function walk(dir){for(const e of await readdir(safe(dir),{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await walk(p);else if(e.name.endsWith('.js'))paths.add(p);}}
 await walk('packages/ingestion/dist');
 paths.add('tools/research/post-draft-history-discovery.mjs');paths.add('tests/node/post-draft-history-discovery.test.mjs');
 return Promise.all([...paths].sort().map(async path=>({path,sha256:sha(await readFile(safe(path)))})));
}

async function sources(){
 const [proposal,audit,capture]=await Promise.all([boundedJson(safe(proposalPath)),boundedJson(safe(auditPath)),boundedJson(safe(capturePath))]);
 if(proposal.value.sourceAuditSha256!==audit.sha256||audit.value.sourceHashes.capture!==capture.sha256||capture.value.source.syntheticOnly)throw Error('source_binding');
 validatePlan(proposal.value,audit.value);return {proposal,audit,capture};
}

async function cachedObservation(db,q){
 const ep=endpoint(q);
 const row=(await sql`SELECT id::text,payload_sha256,fetched_at,source_payload FROM provider_reference_snapshots
  WHERE provider='opendota' AND endpoint=${ep} AND adapter_version='opendota-player-history-v2'
  AND fetched_at>=clock_timestamp()-interval '24 hours' AND fetched_at<=clock_timestamp() ORDER BY fetched_at DESC,id DESC LIMIT 1`.execute(db)).rows[0];
 if(!row)return null;
 const data=Response.safeParse(row.source_payload);if(!data.success)return null;
 const rawBody=JSON.stringify(data.data),observation={data:data.data,rawBody,source:{provider:'opendota',adapterVersion:'opendota-player-history-v2',endpoint:ep,
  knownAt:null,fetchedAt:row.fetched_at.toISOString(),payloadSha256:sha(rawBody),attempts:0,
  cache:{receiptId:row.id,originalPayloadSha256:row.payload_sha256,basis:'normalized_reference_snapshot_not_original_bytes'}}};
 try{validateObservation(observation,q);return observation;}catch{return null;}
}

async function main(){
 const [mode,directory,...extra]=process.argv.slice(2);if(!['register','run','verify'].includes(mode)||!directory||extra.length)throw Error('arguments');
 const dir=safe(directory);if(!relative(join(root,'.tools'),dir)||relative(join(root,'.tools'),dir).startsWith('..'))throw Error('run_directory');
 const src=await sources(),plan=src.proposal.value,hashes={proposal:src.proposal.sha256,audit:src.audit.sha256,capture:src.capture.sha256};
 if(mode==='register'){
  const code=await codeHashes();new PostgresProviderBudget(null,limits());
  const manifest={format:'post-draft-history-discovery-run-v1',registeredAt:new Date().toISOString(),sourceHashes:hashes,code,
   plan,limits:limits(),node:process.version,cacheMaxAgeHours:24,deployable:false};
  await mkdir(dir);await immutable(join(dir,'manifest.json'),manifest);console.log('Registered bounded discovery; HTTP=0');return;
 }
 const manifest=await boundedJson(join(dir,'manifest.json'));
 if(digest(manifest.value.sourceHashes)!==digest(hashes)||digest(manifest.value.plan)!==digest(plan)||
  digest(manifest.value.code)!==digest(await codeHashes())||manifest.value.node!==process.version)throw Error('manifest_changed');
 if(mode==='run'){
  await immutable(join(dir,'started.json'),{manifestSha256:manifest.sha256,startedAt:new Date().toISOString()});
  const db=createDatabase(process.env.DATABASE_URL),state={attempts:0,queryAttempts:0};let index=-1;
  try{
   const shared=new PostgresProviderBudget(db,manifest.value.limits);
   const budget=boundedBudget(shared,state);
   const fetcher=async(url,init)=>{
    if(url!=='https://api.opendota.com/api'+endpoint(plan.queries[index])||init.method!=='GET'||init.redirect!=='error')throw Error('request_scope');
    const n=++state.attempts;++state.queryAttempts;
    await immutable(join(dir,`attempt-${n}.json`),{index,startedAt:new Date().toISOString()});
    try{const response=await fetch(url,init);await immutable(join(dir,`response-${n}.json`),{index,status:response.status,receivedAt:new Date().toISOString()});return response;}
    catch{await immutable(join(dir,`response-${n}.json`),{index,status:null,reason:'network_error'});throw new OpenDotaError('source_network_error');}
   };
   const client=new OpenDotaPlayerHistoryClient(budget,{apiKey:process.env.OPENDOTA_API_KEY,timeoutMs:20000},fetcher);
   const records=await collectQueries(plan,async(q,i)=>{index=i;state.queryAttempts=0;const cache=await cachedObservation(db,q);return cache??await client.discover(q.accountIds,q.cutoffAt,q.options,q.page);},
    r=>immutable(join(dir,`query-${r.index}.json`),r));
   const report={...summarizeDiscovery(plan,records,src.capture.value.source.candidates.map(m=>m.matchId)),
    manifestSha256:manifest.sha256,httpAttempts:state.attempts,operationalWrites:'provider_quotas_only',businessWrites:0};
   await immutable(join(dir,'report.json'),report);console.log(JSON.stringify({status:report.status,counts:report.counts,httpAttempts:state.attempts}));
  }finally{await db.destroy();}
 }else{
  const records=await Promise.all(plan.queries.map((_,i)=>boundedJson(join(dir,`query-${i}.json`)).then(x=>x.value)));
  const report=(await boundedJson(join(dir,'report.json'))).value;
  const started=(await boundedJson(join(dir,'started.json'))).value;
  if(started.manifestSha256!==manifest.sha256||!Number.isFinite(Date.parse(started.startedAt))||
   Date.parse(started.startedAt)<Date.parse(manifest.value.registeredAt))throw Error('start_binding');
  const attempts=(await readdir(dir)).filter(n=>/^attempt-\d+\.json$/.test(n));
  if(attempts.length>18||report.httpAttempts!==attempts.length||report.manifestSha256!==manifest.sha256)throw Error('attempt_binding');
  const counts=new Map();for(let n=1;n<=attempts.length;n++){
   const a=(await boundedJson(join(dir,`attempt-${n}.json`))).value,r=(await boundedJson(join(dir,`response-${n}.json`))).value;
   if(!Number.isInteger(a.index)||a.index<0||a.index>=9||a.index!==r.index||
    (r.status!==null&&(!Number.isInteger(r.status)||r.status<100||r.status>599)))throw Error('attempt_record');
   counts.set(a.index,(counts.get(a.index)??0)+1);
  }
  if([...counts.values()].some(n=>n>2))throw Error('query_budget');
  const expected={...summarizeDiscovery(plan,records,src.capture.value.source.candidates.map(m=>m.matchId)),manifestSha256:manifest.sha256,
   httpAttempts:attempts.length,operationalWrites:'provider_quotas_only',businessWrites:0};
  if(digest(expected)!==digest(report))throw Error('report_replay');
  console.log('Discovery replay PASS; no network or database access');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(()=>{
 console.error('Поиск истории не выполнен. Проверьте manifest, источники и новый каталог; повторный запуск существующего сбора запрещён.');process.exitCode=1;});}
