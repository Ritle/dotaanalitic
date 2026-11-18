import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {projectDetail,assessDetail,collectDetails,detailBudget} from './post-draft-history-details.mjs';
import {createDatabase} from '../../packages/db/dist/index.js';
import {OpenDotaClient,OpenDotaError,PostgresProviderBudget,LeaguesSchema} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const parentDir='.tools/s304-history-details-r1';
const paths={proposal:'docs/evidence/s3-04-history-continuation-proposal.json',parent:parentDir+'/report.json',parentManifest:parentDir+'/manifest.json',
 discovery:'.tools/s304-history-discovery-r1/report.json',discoveryManifest:'.tools/s304-history-discovery-r1/manifest.json',
 capture:'.tools/s304-dataset-capture-final.json',cache:'.tools/s304-details-cache-r1.json'};
const safe=p=>{const x=resolve(root,p),r=relative(root,x);if(!r||r.startsWith('..')||r.includes(':'))throw Error('outside_workspace');return x;};
const immutable=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});

export function validateContinuation(plan,parent,priorAttempts){
 const rows=parent.rows.slice(0,parent.counts.plannedRemote),pending=rows.filter(r=>r.status==='not_attempted').map(r=>r.matchId);
 if(plan.status!=='draft_not_registered_not_executed'||plan.deployable!==false||pending.length!==88||new Set(pending).size!==88||
  digest(plan.mapIds)!==digest(pending)||digest(plan.reuseWithoutHttp)!==digest(rows.filter(r=>r.status==='observed').map(r=>r.matchId))||
  digest(plan.deferredExhaustedMapIds)!==digest(rows.filter(r=>r.status==='unavailable').map(r=>r.matchId)))throw Error('continuation_scope');
 const b=plan.budget;
 if(b.alreadySpent!==8||priorAttempts.length!==b.alreadySpent||parent.httpAttempts!==b.alreadySpent||b.originalGlobalMaxHttpAttempts!==100||
  b.maxNewHttpAttemptsIncludingRetries!==100-b.alreadySpent||b.maxAttemptsPerMapAcrossRuns!==2||
  ['extraDiscoveryRequests','profileRequests','catalogueRequests','businessWrites'].some(k=>b[k]!==0))throw Error('continuation_budget');
 const counts=new Map();for(const a of priorAttempts){if(!rows.some(r=>r.matchId===a.matchId)||pending.includes(a.matchId))throw Error('prior_attempt_scope');counts.set(a.matchId,(counts.get(a.matchId)??0)+1);}
 if([...counts.values()].some(n=>n>2)||plan.deferredExhaustedMapIds.some(id=>counts.get(id)!==2))throw Error('prior_map_budget');
 return plan;
}

export function checkSequence(ids,records){
 if(records.length!==ids.length||records.some((r,i)=>r.matchId!==ids[i]))throw Error('record_order');
 let stopped=false;
 for(const r of records){if(!['observed','unavailable','not_attempted'].includes(r.status)||stopped&&r.status!=='not_attempted'||!stopped&&r.status==='not_attempted')throw Error('record_sequence');if(r.status==='unavailable')stopped=true;}
}

export function mergeContinuation(plan,parent,records,assess,newAttempts){
 checkSequence(plan.mapIds,records);
 if(!Number.isInteger(newAttempts)||newAttempts<records.filter(r=>r.status==='observed').length||newAttempts>plan.budget.maxNewHttpAttemptsIncludingRetries)throw Error('new_attempt_budget');
 const byId=new Map(records.map(r=>[r.matchId,r]));
 const rows=parent.rows.map(old=>{
  const r=byId.get(old.matchId);if(!r)return {...old,collectedIn:'parent'};
  if(old.status!=='not_attempted')throw Error('parent_replacement');
  return {...r,...(r.status==='observed'?{assessment:assess(r)}:{}),collectedIn:'continuation'};
 });
 const assessed=rows.filter(r=>r.assessment),allReasons=[...new Set(assessed.flatMap(r=>[...r.assessment.sourceReasons,...r.assessment.coverageReasons]))].sort();
 return {format:'post-draft-history-continuation-report-v1',status:records.every(r=>r.status==='observed')?'completed_continuation':'partial_continuation',
  parentManifestSha256:plan.parentManifestSha256,parentReportSha256:plan.parentReportSha256,
  httpAttempts:{previous:plan.budget.alreadySpent,new:newAttempts,total:plan.budget.alreadySpent+newAttempts},
  counts:{plannedNew:plan.mapIds.length,observedNew:records.filter(r=>r.status==='observed').length,
   observedRemoteTotal:rows.slice(0,parent.counts.plannedRemote).filter(r=>r.status==='observed').length,
   unavailableRemoteTotal:rows.slice(0,parent.counts.plannedRemote).filter(r=>r.status==='unavailable').length,
   notAttemptedRemoteTotal:rows.slice(0,parent.counts.plannedRemote).filter(r=>r.status==='not_attempted').length,
   reusedRemote:plan.reuseWithoutHttp.length,localReviewed:parent.counts.localReviewed,
   sourceConsistent:assessed.filter(r=>r.assessment.sourceConsistent).length,
   sourceAndCoverageConsistent:assessed.filter(r=>r.assessment.sourceConsistent&&!r.assessment.coverageReasons.length).length},
  reasonCounts:Object.fromEntries(allReasons.map(k=>[k,assessed.filter(r=>[...r.assessment.sourceReasons,...r.assessment.coverageReasons].includes(k)).length])),
  rows,importedMaps:0,businessWrites:0,operationalWrites:'provider_quotas_only',trainingPerformed:false,deployable:false};
}

async function attemptsAt(dir,allowed,startedAt,cap){
 const names=await readdir(dir),n=names.filter(n=>/^attempt-\d+\.json$/.test(n)).length;
 if(n>cap||names.filter(n=>/^response-\d+\.json$/.test(n)).length!==n)throw Error('attempt_inventory');
 const attempts=[],counts=new Map();let last=Date.parse(startedAt);if(!Number.isFinite(last))throw Error('start_time');
 for(let i=1;i<=n;i++){
  const a=(await boundedJson(join(dir,`attempt-${i}.json`))).value,r=(await boundedJson(join(dir,`response-${i}.json`))).value,time=Date.parse(a.startedAt);
  if(!allowed.includes(a.matchId)||a.matchId!==r.matchId||!Number.isFinite(time)||time<last||!(r.status===null||Number.isInteger(r.status)&&r.status>=100&&r.status<=599))throw Error('attempt_binding');
  if(r.status!==null&&(!Number.isFinite(Date.parse(r.receivedAt))||Date.parse(r.receivedAt)<time))throw Error('response_time');
  last=time;counts.set(a.matchId,(counts.get(a.matchId)??0)+1);attempts.push({...a,response:r});
 }
 if([...counts.values()].some(n=>n>2))throw Error('map_budget');return attempts;
}

export function validateReceiptAttempts(records,attempts){
 for(const r of records){const a=attempts.filter(a=>a.matchId===r.matchId);
  if(r.status==='not_attempted'&&a.length||r.status==='observed'&&(!a.length||a.at(-1).response.status!==200||r.receipt.source.attempts!==a.length))throw Error('receipt_attempt_binding');
 }
}

async function sources(){
 const s=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await boundedJson(safe(p))])));
 const plan=s.proposal.value,manifest=s.parentManifest.value;
 if(plan.parentManifestSha256!==s.parentManifest.sha256||plan.parentReportSha256!==s.parent.sha256||s.parent.value.manifestSha256!==s.parentManifest.sha256||s.capture.value.source.syntheticOnly)throw Error('parent_binding');
 for(const k of ['discovery','discoveryManifest','capture','cache'])if(manifest.sourceHashes[k]!==s[k].sha256)throw Error('parent_source_changed');
 const started=(await boundedJson(safe(parentDir+'/started.json'))).value;
 if(started.manifestSha256!==s.parentManifest.sha256||!(Date.parse(started.startedAt)>=Date.parse(manifest.registeredAt)))throw Error('parent_start');
 s.priorAttempts=await attemptsAt(safe(parentDir),manifest.plan.mapIds,started.startedAt,100);
 validateContinuation(plan,s.parent.value,s.priorAttempts);
 const old=s.parent.value.rows.slice(0,manifest.plan.mapIds.length);checkSequence(manifest.plan.mapIds,old);validateReceiptAttempts(old,s.priorAttempts);
 return s;
}
async function codeHashes(s){
 const code=[...s.parentManifest.value.code];for(const c of code)if(sha(await readFile(safe(c.path)))!==c.sha256)throw Error('frozen_code_changed');
 for(const path of ['tools/research/post-draft-history-continuation.mjs','tests/node/post-draft-history-continuation.test.mjs'])code.push({path,sha256:sha(await readFile(safe(path)))});
 return code.sort((a,b)=>a.path.localeCompare(b.path));
}
function reportFor(s,records,attempts,manifestSha256){
 const leagues=LeaguesSchema.parse(s.cache.value.leagues.source_payload),candidates=new Map(s.discovery.value.maps.map(r=>[r.matchId,r]));
 return {...mergeContinuation(s.proposal.value,s.parent.value,records,r=>assessDetail(r.receipt,candidates.get(r.matchId),s.discoveryManifest.value.plan.queries,leagues,s.capture.value.source.identities),attempts),manifestSha256};
}
async function main(){
 const [mode,directory,...extra]=process.argv.slice(2);if(!['register','run','verify'].includes(mode)||!directory||extra.length)throw Error('arguments');
 const dir=safe(directory),rel=relative(join(root,'.tools'),dir);if(!rel||rel.startsWith('..')||rel.includes(':'))throw Error('directory');
 const s=await sources(),plan=s.proposal.value,sourceHashes=Object.fromEntries(Object.entries(s).filter(([k])=>k!=='priorAttempts').map(([k,v])=>[k,v.sha256]));
 if(mode==='register'){
  const limits=s.parentManifest.value.limits;new PostgresProviderBudget(null,limits);
  const code=await codeHashes(s);await mkdir(dir);await immutable(join(dir,'manifest.json'),{format:'post-draft-history-continuation-manifest-v1',registeredAt:new Date().toISOString(),
   sourceHashes,plan,limits,code,node:process.version,priorAttemptsSha256:digest(s.priorAttempts),deployable:false});console.log('Continuation registered; HTTP=0');return;
 }
 const manifest=await boundedJson(join(dir,'manifest.json'));
 if(digest(manifest.value.sourceHashes)!==digest(sourceHashes)||digest(manifest.value.code)!==digest(await codeHashes(s))||digest(manifest.value.plan)!==digest(plan)||
  manifest.value.node!==process.version||manifest.value.priorAttemptsSha256!==digest(s.priorAttempts)||digest(manifest.value.limits)!==digest(s.parentManifest.value.limits))throw Error('manifest_changed');
 if(mode==='run'){
  await immutable(join(dir,'started.json'),{manifestSha256:manifest.sha256,startedAt:new Date().toISOString()});
  const state={attempts:plan.budget.alreadySpent,mapAttempts:0};let currentId=null;
  const db=createDatabase(process.env.DATABASE_URL);
  try{
   const budget=detailBudget(new PostgresProviderBudget(db,manifest.value.limits),state);
   const fetcher=async(url,init)=>{
    if(!plan.mapIds.includes(currentId)||String(url)!==`https://api.opendota.com/api/matches/${currentId}`||init.method!=='GET'||init.redirect!=='error')throw Error('request_scope');
    const n=++state.attempts-plan.budget.alreadySpent;state.mapAttempts++;
    await immutable(join(dir,`attempt-${n}.json`),{matchId:currentId,startedAt:new Date().toISOString()});
    try{const response=await fetch(url,init);await immutable(join(dir,`response-${n}.json`),{matchId:currentId,status:response.status,receivedAt:new Date().toISOString()});return response;}
    catch{await immutable(join(dir,`response-${n}.json`),{matchId:currentId,status:null,reason:'network_error'});throw new OpenDotaError('source_network_error');}
   };
   const client=new OpenDotaClient({apiKey:process.env.OPENDOTA_API_KEY,maxRequests:92,attempts:2,requestsPerMinute:manifest.value.limits.rpm,timeoutMs:20000,maxWaitMs:5000},{budget,fetch:fetcher});
   const records=await collectDetails(plan.mapIds,async id=>{
    currentId=id;state.mapAttempts=0;const receipt=projectDetail(await client.getMatchSource(id),id);
    const token=process.env.OPENDOTA_API_KEY?.trim();if(token&&JSON.stringify(receipt).includes(token))throw new OpenDotaError('source_invalid_json');return receipt;
   },r=>immutable(join(dir,`map-${r.matchId}.json`),r));
   const report=reportFor(s,records,state.attempts-plan.budget.alreadySpent,manifest.sha256);await immutable(join(dir,'report.json'),report);
   console.log(JSON.stringify({status:report.status,httpAttempts:report.httpAttempts,counts:report.counts,reasonCounts:report.reasonCounts}));
  }finally{await db.destroy();}
 }else{
  const started=(await boundedJson(join(dir,'started.json'))).value;
  if(started.manifestSha256!==manifest.sha256||!(Date.parse(started.startedAt)>=Date.parse(manifest.value.registeredAt)))throw Error('start_binding');
  const records=await Promise.all(plan.mapIds.map(id=>boundedJson(join(dir,`map-${id}.json`)).then(v=>v.value)));
  const attempts=await attemptsAt(dir,plan.mapIds,started.startedAt,92);validateReceiptAttempts(records,attempts);
  if(digest(reportFor(s,records,attempts.length,manifest.sha256))!==digest((await boundedJson(join(dir,'report.json'))).value))throw Error('report_replay');
  console.log('Continuation replay PASS; HTTP=0 DB=0');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Продолжение сбора отклонено: проверьте manifest, исходные данные и каталог запуска. Существующий запуск не перезаписывается.');process.exitCode=1;
});
