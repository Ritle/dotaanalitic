import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {projectDetail,assessDetail,collectDetails,detailBudget} from './post-draft-history-details.mjs';
import {checkSequence,validateReceiptAttempts} from './post-draft-history-continuation.mjs';
import {createDatabase} from '../../packages/db/dist/index.js';
import {OpenDotaClient,OpenDotaError,PostgresProviderBudget,LeaguesSchema} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const child='.tools/s304-history-continuation-r1',first='.tools/s304-history-details-r1',dir=join(root,'.tools/s304-history-quota-resume-r1');
const immutable=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});

/** A quota refusal made before HTTP does not consume the map's attempts. */
export function recoveryPlan(parent,originalIds,attempts){
 if(new Set(originalIds).size!==originalIds.length||attempts.length!==parent.httpAttempts.total||attempts.length>=100)throw Error('prior_budget');
 const counts=new Map();for(const a of attempts){if(!originalIds.includes(a.matchId))throw Error('prior_scope');counts.set(a.matchId,(counts.get(a.matchId)??0)+1);}
 if([...counts.values()].some(n=>n>2))throw Error('prior_map_budget');
 const rows=originalIds.map(id=>parent.rows.find(r=>r.matchId===id));if(rows.some(r=>!r))throw Error('parent_scope');
 const deferred=rows.filter(r=>r.status==='unavailable'&&r.reason==='source_rate_limited'&&!counts.has(r.matchId));
 if(deferred.length!==1||!Number.isFinite(deferred[0].retryAfterMs)||deferred[0].retryAfterMs<=0)throw Error('quota_recovery_scope');
 const ids=rows.filter(r=>r.status==='not_attempted'||r===deferred[0]).map(r=>r.matchId);
 if(ids.some(id=>counts.has(id)))throw Error('already_attempted');
 return {mapIds:ids,alreadySpent:attempts.length,maxNewAttempts:100-attempts.length,maxAttemptsPerMap:2,
  previousQuotaRefusal:{matchId:deferred[0].matchId,retryAfterMs:deferred[0].retryAfterMs},
  quotaPolicy:'same_persistent_budget_no_reset',providerExtras:0,businessWrites:0,deployable:false};
}
export function mergeRecovery(parent,plan,records,assess,attempts){
 checkSequence(plan.mapIds,records);
 if(!Number.isInteger(attempts)||attempts<records.filter(r=>r.status==='observed').length||attempts>plan.maxNewAttempts)throw Error('recovery_budget');
 const byId=new Map(records.map(r=>[r.matchId,r]));
 const rows=parent.rows.map(old=>{
  const r=byId.get(old.matchId);if(!r)return structuredClone(old);
  if(old.status!=='not_attempted'&&!(old.status==='unavailable'&&old.reason==='source_rate_limited'&&old.matchId===plan.previousQuotaRefusal.matchId))throw Error('parent_replacement');
  return {...r,collectedIn:'quota_resume',priorState:{status:old.status,reason:old.reason??null,retryAfterMs:old.retryAfterMs??null},...(r.status==='observed'?{assessment:assess(r)}:{})};
 });
 const remote=rows.slice(0,95),assessed=rows.filter(r=>r.assessment),reasons=[...new Set(assessed.flatMap(r=>[...r.assessment.sourceReasons,...r.assessment.coverageReasons]))].sort();
 return {format:'post-draft-history-quota-resume-report-v1',status:records.every(r=>r.status==='observed')?'completed_quota_resume':'partial_quota_resume',
  httpAttempts:{previous:plan.alreadySpent,new:attempts,total:plan.alreadySpent+attempts},
  counts:{planned:plan.mapIds.length,observedNew:records.filter(r=>r.status==='observed').length,observedRemoteTotal:remote.filter(r=>r.status==='observed').length,
   unavailableRemoteTotal:remote.filter(r=>r.status==='unavailable').length,notAttemptedRemoteTotal:remote.filter(r=>r.status==='not_attempted').length,
   localReviewed:parent.counts.localReviewed,sourceConsistent:assessed.filter(r=>r.assessment.sourceConsistent).length,
   sourceAndCoverageConsistent:assessed.filter(r=>r.assessment.sourceConsistent&&!r.assessment.coverageReasons.length).length},
  reasonCounts:Object.fromEntries(reasons.map(k=>[k,assessed.filter(r=>[...r.assessment.sourceReasons,...r.assessment.coverageReasons].includes(k)).length])),
  rows,providerExtras:0,businessWrites:0,operationalWrites:'provider_quotas_only',importedMaps:0,trainingPerformed:false,deployable:false};
}
async function journal(directory){
 const names=await readdir(directory),n=names.filter(n=>/^attempt-\d+\.json$/.test(n)).length;
 if(names.filter(n=>/^response-\d+\.json$/.test(n)).length!==n)throw Error('journal_count');
 return Promise.all(Array.from({length:n},async(_,i)=>{
  const a=(await boundedJson(join(directory,`attempt-${i+1}.json`))).value,response=(await boundedJson(join(directory,`response-${i+1}.json`))).value;
  if(a.matchId!==response.matchId)throw Error('journal_binding');return {...a,response};
 }));
}
async function main(){
 const mode=process.argv[2];if(!['register','run','verify'].includes(mode)||process.argv.length!==3)throw Error('arguments');
 const parent=await boundedJson(join(root,child,'report.json')),pm=await boundedJson(join(root,child,'manifest.json')),fm=await boundedJson(join(root,first,'manifest.json'));
 if(parent.sha256!=='2be7127eee348dfa80501774bcb90a867292b51c4e3a1a85f2c42bc573eeaa1f'||parent.value.manifestSha256!==pm.sha256||pm.value.plan.parentManifestSha256!==fm.sha256)throw Error('parent_binding');
 const prior=[...await journal(join(root,first)),...await journal(join(root,child))],plan=recoveryPlan(parent.value,fm.value.plan.mapIds,prior);
 if(plan.mapIds.length!==5||plan.alreadySpent!==91||plan.maxNewAttempts!==9)throw Error('registered_scope');
 const sources={};for(const [k,p] of Object.entries({discovery:'.tools/s304-history-discovery-r1/report.json',discoveryManifest:'.tools/s304-history-discovery-r1/manifest.json',cache:'.tools/s304-details-cache-r1.json',capture:'.tools/s304-dataset-capture-final.json'})){
  sources[k]=await boundedJson(join(root,p));if(sources[k].sha256!==pm.value.sourceHashes[k])throw Error('source_changed');
 }
 const code=[...pm.value.code];for(const c of code)if(sha(await readFile(join(root,c.path)))!==c.sha256)throw Error('frozen_code_changed');
 for(const p of ['tools/research/post-draft-history-quota-resume.mjs','tests/node/post-draft-history-quota-resume.test.mjs'])code.push({path:p,sha256:sha(await readFile(join(root,p)))});
 const binding={parentReportSha256:parent.sha256,parentManifestSha256:pm.sha256,priorAttemptsSha256:digest(prior),plan,code,limits:pm.value.limits,node:process.version};
 if(mode==='register'){new PostgresProviderBudget(null,binding.limits);await mkdir(dir);await immutable(join(dir,'manifest.json'),{...binding,registeredAt:new Date().toISOString()});console.log('Quota resume registered; HTTP=0');return;}
 const manifest=await boundedJson(join(dir,'manifest.json'));const {registeredAt,...actual}=manifest.value;
 if(digest(binding)!==digest(actual))throw Error('manifest_changed');
 const assess=r=>assessDetail(r.receipt,sources.discovery.value.maps.find(c=>c.matchId===r.matchId),sources.discoveryManifest.value.plan.queries,
  LeaguesSchema.parse(sources.cache.value.leagues.source_payload),sources.capture.value.source.identities);
 const reportFor=(records,attempts)=>({...mergeRecovery(parent.value,plan,records,assess,attempts),manifestSha256:manifest.sha256,parentReportSha256:parent.sha256});
 if(mode==='run'){
  await immutable(join(dir,'started.json'),{manifestSha256:manifest.sha256,startedAt:new Date().toISOString()});
  const db=createDatabase(process.env.DATABASE_URL),state={attempts:plan.alreadySpent,mapAttempts:0};let currentId=null;
  try{
   const budget=detailBudget(new PostgresProviderBudget(db,binding.limits),state);
   const fetcher=async(url,init)=>{
    if(!plan.mapIds.includes(currentId)||String(url)!==`https://api.opendota.com/api/matches/${currentId}`||init.method!=='GET'||init.redirect!=='error')throw Error('scope');
    const n=++state.attempts-plan.alreadySpent;state.mapAttempts++;
    await immutable(join(dir,`attempt-${n}.json`),{matchId:currentId,startedAt:new Date().toISOString()});
    try{const response=await fetch(url,init);await immutable(join(dir,`response-${n}.json`),{matchId:currentId,status:response.status,receivedAt:new Date().toISOString()});return response;}
    catch{await immutable(join(dir,`response-${n}.json`),{matchId:currentId,status:null,reason:'network_error'});throw new OpenDotaError('source_network_error');}
   };
   const client=new OpenDotaClient({apiKey:process.env.OPENDOTA_API_KEY,maxRequests:9,attempts:2,requestsPerMinute:binding.limits.rpm,timeoutMs:20000,maxWaitMs:5000},{budget,fetch:fetcher});
   const records=await collectDetails(plan.mapIds,async id=>{currentId=id;state.mapAttempts=0;const receipt=projectDetail(await client.getMatchSource(id),id);
    const token=process.env.OPENDOTA_API_KEY?.trim();if(token&&JSON.stringify(receipt).includes(token))throw new OpenDotaError('source_invalid_json');return receipt;
   },r=>immutable(join(dir,`map-${r.matchId}.json`),r));
   const report=reportFor(records,state.attempts-plan.alreadySpent);await immutable(join(dir,'report.json'),report);console.log(JSON.stringify({status:report.status,httpAttempts:report.httpAttempts,counts:report.counts,reasonCounts:report.reasonCounts}));
  }finally{await db.destroy();}
 }else{
  const started=(await boundedJson(join(dir,'started.json'))).value;if(started.manifestSha256!==manifest.sha256||!(Date.parse(started.startedAt)>=Date.parse(registeredAt)))throw Error('start_binding');
  const attempts=await journal(dir),counts=new Map();if(attempts.length>plan.maxNewAttempts)throw Error('attempt_budget');
  for(const a of attempts){if(!plan.mapIds.includes(a.matchId)||!(Date.parse(a.startedAt)>=Date.parse(started.startedAt))||
    !(a.response.status===null||Number.isInteger(a.response.status)&&a.response.status>=100&&a.response.status<=599))throw Error('attempt_scope');counts.set(a.matchId,(counts.get(a.matchId)??0)+1);}
  if([...counts.values()].some(n=>n>2))throw Error('map_budget');
  const records=await Promise.all(plan.mapIds.map(id=>boundedJson(join(dir,`map-${id}.json`)).then(v=>v.value)));validateReceiptAttempts(records,attempts);
  if(digest(reportFor(records,attempts.length))!==digest((await boundedJson(join(dir,'report.json'))).value))throw Error('replay_mismatch');
  console.log('Quota resume replay PASS; HTTP=0 DB=0');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Возобновление после квоты отклонено: проверьте manifest и снимки; повторная запись запрещена.');process.exitCode=1;});
