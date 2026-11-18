import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {createDatabase,resolveIdentity} from '../../packages/db/dist/index.js';
import {OpenDotaClient,OpenDotaError,PostgresProviderBudget,parseSource,validatePlayerHistoryMap,LeaguesSchema} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const paths={proposal:'docs/evidence/s3-04-history-details-proposal.json',discovery:'.tools/s304-history-discovery-r1/report.json',
 discoveryManifest:'.tools/s304-history-discovery-r1/manifest.json',capture:'.tools/s304-dataset-capture-final.json',cache:'.tools/s304-details-cache-r1.json'};
const safe=p=>{const x=resolve(root,p),r=relative(root,x);if(!r||r.startsWith('..')||r.includes(':'))throw Error('outside_workspace');return x;};
const immutable=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const limits=()=>({rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)});
const cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;

export function validateDetailPlan(plan,discovery){
 const expected=discovery.maps.filter(m=>!m.knownInFrozenCapture).sort((a,b)=>Math.min(...a.observations.map(o=>o.row.start_time))-Math.min(...b.observations.map(o=>o.row.start_time))||cmp(a.matchId,b.matchId)).map(m=>m.matchId);
 if(plan.status!=='draft_not_registered_not_executed'||plan.deployable!==false||expected.length!==95||digest(plan.mapIds)!==digest(expected)||new Set(plan.mapIds).size!==95||
  digest(plan.localReview.map(r=>r.matchId))!==digest(discovery.maps.filter(m=>m.knownInFrozenCapture).map(m=>m.matchId))||
  plan.budget.maxRemoteMapIds!==95||plan.budget.maxDetailHttpAttemptsIncludingRetries!==100||plan.budget.maxAttemptsPerMap!==2||
  ['extraDiscoveryRequests','profileRequests','catalogueRequests','businessWrites'].some(k=>plan.budget[k]!==0))throw Error('plan_scope');
 return plan;
}

/** Persist the existing ingestion projection, never full chat/profile response data. */
export function projectDetail(observation,id,cache=null){
 const parsed=parseSource(observation,id);
 const raw=JSON.parse(observation.rawBody);
 if(raw&&typeof raw==='object'&&('synthetic' in raw||'_fixture' in raw))throw Error('synthetic_source_rejected');
 return {source:observation.source,projection:parsed.projection,projectionSha256:sha(JSON.stringify(parsed.projection)),
  sourceIssues:parsed.issues,originalResponseBytesRetained:false,basis:cache?'normalized_local_receipt':'validated_http_projected',cache};
}

export function assessDetail(receipt,candidate,queries,leagueRows,identities){
 if(sha(JSON.stringify(receipt.projection))!==receipt.projectionSha256||receipt.source.endpoint!==`/matches/${candidate.matchId}`)throw Error('projection_binding');
 const rawBody=JSON.stringify(receipt.projection),observation={data:receipt.projection,rawBody,
  source:{...receipt.source,payloadSha256:receipt.projectionSha256}};
 const parsed=parseSource(observation,candidate.matchId),m=parsed.match,reasons=[...receipt.sourceIssues,...parsed.issues],coverageReasons=[];
 if(!m)reasons.push('SOURCE_SCHEMA_INVALID');
 const cutoffs=[...new Set(candidate.observations.map(o=>queries[o.queryIndex].cutoffAt))];
 for(const cutoff of cutoffs){
  const rows=candidate.observations.filter(o=>queries[o.queryIndex].cutoffAt===cutoff).map(o=>o.row);
  const checked=validatePlayerHistoryMap({matchId:candidate.matchId,players:rows},observation,leagueRows,cutoff);
  reasons.push(...checked.reasons);
  if(m&&(!m.start_time||!m.duration||(m.start_time+m.duration)*1000>=Date.parse(cutoff)))reasons.push('STRICT_COMPLETION_REQUIRED');
 }
 let members=[];
 if(m){
  const slots=[0,1,2,3,4,128,129,130,131,132],players=m.players??[];
  if(players.length!==10||new Set(players.map(p=>p.player_slot)).size!==10||players.some(p=>!slots.includes(p.player_slot)))coverageReasons.push('TEN_NATIVE_SLOTS_REQUIRED');
  if(players.length!==10||players.some(p=>p.account_id==null)||new Set(players.map(p=>p.account_id)).size!==10)coverageReasons.push('TEN_DISTINCT_ACCOUNTS_REQUIRED');
  if(players.length!==10||players.some(p=>!p.hero_id)||new Set(players.map(p=>p.hero_id)).size!==10)coverageReasons.push('TEN_DISTINCT_FINAL_HEROES_REQUIRED');
  if(!m.radiant_team_id||!m.dire_team_id||m.radiant_team_id===m.dire_team_id)coverageReasons.push('TEAM_SIDES_UNKNOWN');
  if(m.radiant_team_id&&m.radiant_team?.team_id&&m.radiant_team_id!==m.radiant_team.team_id||m.dire_team_id&&m.dire_team?.team_id&&m.dire_team_id!==m.dire_team.team_id)coverageReasons.push('TEAM_REFERENCE_CONFLICT');
  if(!m.series_id)coverageReasons.push('SOURCE_SERIES_UNKNOWN');
  members=players.map(p=>{
   const identity=p.account_id?resolveIdentity(identities,p.account_id,null):null;
   const linked=identity?.playerId?new Set(identities.filter(i=>i.status==='verified'&&i.playerId===identity.playerId).map(i=>i.externalAccountId)):new Set();
   const status=linked.size>1?'cross_account_unsupported':identity?.status??'unknown';
   if(status!=='verified')coverageReasons.push('CANONICAL_IDENTITY_'+status.toUpperCase());
   return {slot:p.player_slot??null,accountId:p.account_id??null,heroId:p.hero_id??null,canonicalPlayerId:identity?.playerId??null,
    identityStatus:status,proofIds:identity?.observationIds??[]};
  }).sort((a,b)=>(a.slot??999)-(b.slot??999));
 }
 return {matchId:candidate.matchId,sourceConsistent:reasons.length===0,sourceReasons:[...new Set(reasons)].sort(),
  coverageReasons:[...new Set(coverageReasons)].sort(),members,
  sourceTeamIds:m?{radiant:m.radiant_team_id??null,dire:m.dire_team_id??null}:null,sourceSeriesId:m?.series_id??null,
  providerPatchId:m?.patch??null,canonicalPatchId:null,sourceClock:receipt.source,
  identityBasis:'current_verified_same_numeric_account_from_frozen_capture',seriesCompleteness:'unknown',
  trainingEligible:false,deployable:false};
}

export function detailBudget(shared,state){return {beforeRequest:async()=>{
 if(state.attempts>=100||state.mapAttempts>=2)throw new OpenDotaError('request_budget_exhausted');await shared.beforeRequest();},observe:(...args)=>shared.observe(...args)};}

export async function collectDetails(ids,get,save){
 const records=[];let stopped=false;
 for(const id of ids){let r={matchId:id,status:'not_attempted',reason:'earlier_source_unavailable'};
  if(!stopped)try{r={matchId:id,status:'observed',receipt:await get(id)};}
  catch(e){r={matchId:id,status:'unavailable',reason:e instanceof OpenDotaError?e.code:'local_or_validation_error',retryAfterMs:e instanceof OpenDotaError?e.retryAfterMs:null};stopped=true;}
  await save(r);records.push(r);
 }return records;
}

function cacheObservation(row,id){
 const rawBody=JSON.stringify(row.source_payload);
 return {data:row.source_payload,rawBody,source:{provider:'opendota',adapterVersion:row.adapter_version,endpoint:`/matches/${id}`,
  fetchedAt:row.fetched_at,knownAt:null,payloadSha256:sha(rawBody),attempts:0}};
}

async function sources(){
 const result=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await boundedJson(safe(p))])));
 const p=result.proposal.value;
 if(p.discoveryManifestSha256!==result.discoveryManifest.sha256||p.discoveryReportSha256!==result.discovery.sha256||
  result.capture.value.source.syntheticOnly)throw Error('source_binding');
 validateDetailPlan(p,result.discovery.value);return result;
}
async function codeHashes(src){
 const list=[...src.discoveryManifest.value.code];
 for(const e of list)if(sha(await readFile(safe(e.path)))!==e.sha256)throw Error('frozen_code_changed');
 for(const path of ['tools/research/post-draft-history-details.mjs','tests/node/post-draft-history-details.test.mjs'])list.push({path,sha256:sha(await readFile(safe(path)))});
 return list.sort((a,b)=>a.path.localeCompare(b.path));
}
function makeReport(plan,records,local,src,manifestSha256,attempts){
 if(records.length!==plan.mapIds.length||records.some((r,i)=>r.matchId!==plan.mapIds[i]))throw Error('record_set');
 if(local.length!==plan.localReview.length||local.some((r,i)=>r.matchId!==plan.localReview[i].matchId||!['observed','unavailable'].includes(r.status)))throw Error('local_record_set');
 let stopped=false;for(const r of records){if(!['observed','unavailable','not_attempted'].includes(r.status)||stopped&&r.status!=='not_attempted'||!stopped&&r.status==='not_attempted')throw Error('record_sequence');if(r.status==='unavailable')stopped=true;}
 const leagues=src.cache.value.leagues?LeaguesSchema.parse(src.cache.value.leagues.source_payload):[];
 const candidates=new Map(src.discovery.value.maps.map(m=>[m.matchId,m]));
 const rows=[...records,...local].map(r=>({...r,...(r.status==='observed'?{assessment:assessDetail(r.receipt,candidates.get(r.matchId),src.discoveryManifest.value.plan.queries,leagues,src.capture.value.source.identities)}:{})}));
 const assessed=rows.filter(r=>r.assessment),reasons=[...new Set(assessed.flatMap(r=>[...r.assessment.sourceReasons,...r.assessment.coverageReasons]))].sort();
 return {format:'post-draft-history-details-report-v1',status:records.every(r=>r.status==='observed')?'completed_collection':'partial_collection',
  manifestSha256,httpAttempts:attempts,counts:{plannedRemote:95,observedRemote:records.filter(r=>r.status==='observed').length,localReviewed:local.filter(r=>r.status==='observed').length,
   sourceConsistent:assessed.filter(r=>r.assessment.sourceConsistent).length,
   sourceAndCoverageConsistent:assessed.filter(r=>r.assessment.sourceConsistent&&!r.assessment.coverageReasons.length).length},
  reasonCounts:Object.fromEntries(reasons.map(k=>[k,assessed.filter(r=>[...r.assessment.sourceReasons,...r.assessment.coverageReasons].includes(k)).length])),
  rows,importedMaps:0,businessWrites:0,operationalWrites:'provider_quotas_only',trainingPerformed:false,deployable:false};
}

async function main(){
 const [mode,directory,...extra]=process.argv.slice(2);if(!['register','run','verify'].includes(mode)||!directory||extra.length)throw Error('arguments');
 const dir=safe(directory),rel=relative(join(root,'.tools'),dir);if(!rel||rel.startsWith('..')||rel.includes(':'))throw Error('directory');
 const src=await sources(),plan=src.proposal.value,sourceHashes=Object.fromEntries(Object.entries(src).map(([k,v])=>[k,v.sha256]));
 if(mode==='register'){
  new PostgresProviderBudget(null,limits());await mkdir(dir);await immutable(join(dir,'manifest.json'),{format:'post-draft-history-details-manifest-v1',registeredAt:new Date().toISOString(),
   sourceHashes,plan,code:await codeHashes(src),limits:limits(),node:process.version,projectionPolicy:'opendota-map-v2-identity',deployable:false});console.log('Details registered; HTTP=0');return;
 }
 const manifest=await boundedJson(join(dir,'manifest.json'));
 if(digest(manifest.value.sourceHashes)!==digest(sourceHashes)||digest(manifest.value.code)!==digest(await codeHashes(src))||digest(manifest.value.plan)!==digest(plan)||manifest.value.node!==process.version)throw Error('manifest_changed');
 const cache=new Map(src.cache.value.receipts.map(r=>[r.provider_match_id,r]));
 const cached=id=>{const r=cache.get(id);return r?projectDetail(cacheObservation(r,id),id,{receiptId:r.id,originalPayloadSha256:r.payload_sha256,knownAt:r.known_at,basis:'stored_projection_not_original_response'}):null;};
 if(mode==='run'){
  await immutable(join(dir,'started.json'),{manifestSha256:manifest.sha256,startedAt:new Date().toISOString()});
  const local=plan.localReview.map(p=>{const receipt=cached(p.matchId);return {matchId:p.matchId,status:receipt?'observed':'unavailable',...(receipt?{receipt}:{reason:'local_receipt_missing'})};});
  await immutable(join(dir,'local-review.json'),local);
  const state={attempts:0,mapAttempts:0};let currentId=null;
  const db=createDatabase(process.env.DATABASE_URL);
  try{
   const budget=detailBudget(new PostgresProviderBudget(db,manifest.value.limits),state);
   const fetcher=async(url,init)=>{
    if(String(url)!==`https://api.opendota.com/api/matches/${currentId}`||init.method!=='GET'||init.redirect!=='error')throw Error('request_scope');
    const n=++state.attempts;state.mapAttempts++;await immutable(join(dir,`attempt-${n}.json`),{matchId:currentId,startedAt:new Date().toISOString()});
    try{const response=await fetch(url,init);await immutable(join(dir,`response-${n}.json`),{matchId:currentId,status:response.status,receivedAt:new Date().toISOString()});return response;}
    catch{await immutable(join(dir,`response-${n}.json`),{matchId:currentId,status:null,reason:'network_error'});throw new OpenDotaError('source_network_error');}
   };
   const client=new OpenDotaClient({apiKey:process.env.OPENDOTA_API_KEY,maxRequests:100,attempts:2,requestsPerMinute:manifest.value.limits.rpm,timeoutMs:20000,maxWaitMs:5000},{budget,fetch:fetcher});
   const records=await collectDetails(plan.mapIds,async id=>{
    currentId=id;state.mapAttempts=0;const existing=cached(id);if(existing)return existing;
    const receipt=projectDetail(await client.getMatchSource(id),id);
    const token=process.env.OPENDOTA_API_KEY?.trim();if(token&&JSON.stringify(receipt).includes(token))throw new OpenDotaError('source_invalid_json');
    return receipt;
   },r=>immutable(join(dir,`map-${r.matchId}.json`),r));
   const report=makeReport(plan,records,local,src,manifest.sha256,state.attempts);await immutable(join(dir,'report.json'),report);
   console.log(JSON.stringify({status:report.status,counts:report.counts,reasonCounts:report.reasonCounts,httpAttempts:state.attempts}));
  }finally{await db.destroy();}
 }else{
  const records=await Promise.all(plan.mapIds.map(id=>boundedJson(join(dir,`map-${id}.json`)).then(x=>x.value))),local=(await boundedJson(join(dir,'local-review.json'))).value;
  const started=(await boundedJson(join(dir,'started.json'))).value;if(started.manifestSha256!==manifest.sha256||!Number.isFinite(Date.parse(started.startedAt))||!Number.isFinite(Date.parse(manifest.value.registeredAt))||Date.parse(started.startedAt)<Date.parse(manifest.value.registeredAt))throw Error('start_binding');
  const attempts=(await readdir(dir)).filter(n=>/^attempt-\d+\.json$/.test(n));if(attempts.length>100)throw Error('attempt_budget');
  const counts=new Map();for(let n=1;n<=attempts.length;n++){const a=(await boundedJson(join(dir,`attempt-${n}.json`))).value,r=(await boundedJson(join(dir,`response-${n}.json`))).value;
   if(!plan.mapIds.includes(a.matchId)||a.matchId!==r.matchId||!Number.isFinite(Date.parse(a.startedAt))||Date.parse(a.startedAt)<Date.parse(started.startedAt)||
    !(r.status===null||Number.isInteger(r.status)&&r.status>=100&&r.status<=599))throw Error('attempt_binding');counts.set(a.matchId,(counts.get(a.matchId)??0)+1);}
  if([...counts.values()].some(n=>n>2))throw Error('map_budget');
  const expected=makeReport(plan,records,local,src,manifest.sha256,attempts.length);
  if(digest(expected)!==digest((await boundedJson(join(dir,'report.json'))).value))throw Error('report_replay');
  console.log('Details replay PASS; HTTP=0 DB=0');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Проверка деталей не выполнена. Проверьте manifest, источники и новый каталог; существующий сбор нельзя запускать повторно.');process.exitCode=1;});
