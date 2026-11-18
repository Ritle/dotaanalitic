/** One bounded source-semantics experiment. No canonical facts, labels or predictions are written. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createDatabase,RoleProfileRepository} from '../../packages/db/dist/index.js';
import {OpenDotaClient,PostgresProviderBudget,retryAfterMilliseconds} from '../../packages/ingestion/dist/index.js';
import {boundedBody} from './draft-target-source-pilot.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const path='docs/evidence/s3-04-gameplay-boundary-plan.json',bytes=await readFile(path),plan=JSON.parse(bytes);
assert.deepEqual(plan.matchIds,['9070527945','9068910292','9067177642']);
assert.equal(plan.opendotaMaxAttempts,3);assert.equal(plan.stratzMaxAttempts,1);assert.equal(plan.requestRetries,0);
assert.equal(plan.maxResponseBytes,4194304);assert.equal(plan.timeoutMs,15000);assert.equal(plan.canonicalWrites,0);
const dir='.tools/s304-gameplay-boundary-r1';await mkdir(dir);await writeFile(dir+'/plan.json',bytes,{flag:'wx'});
const db=createDatabase(process.env.DATABASE_URL),report={format:'gameplay-boundary-receipts-v1',planSha256:hash(bytes),
 codeSha256:hash(await readFile(new URL(import.meta.url))),startedAt:new Date().toISOString(),requests:[],canonicalWrites:0,deployable:false};
const token=(process.env.STRATZ_API_TOKEN??'').trim().replace(/^Bearer\s+/i,''),key=process.env.OPENDOTA_API_KEY;
try{
 const shared=new PostgresProviderBudget(db,{rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)});
 const client=new OpenDotaClient({apiKey:key,attempts:1,maxRequests:3,maxWaitMs:0,timeoutMs:15000,maxResponseBytes:4194304},
   {budget:{beforeRequest:async()=>{const c=await shared.claim();if(!c.allowed)throw Error('quota_blocked');},observe:(...args)=>shared.observe(...args)}});
 for(const id of plan.matchIds){
  const r={provider:'opendota',matchId:id,requestedAt:new Date().toISOString(),knownAt:null};report.requests.push(r);
  try{
   const o=await client.getMatchSource(id);assert(![key,token].some(s=>s&&o.rawBody.includes(s)),'unsafe_payload');
   r.source=o.source;r.file='opendota-'+id+'.json';r.sha256=hash(o.rawBody);r.status=200;r.result='captured';
   await writeFile(dir+'/'+r.file,o.rawBody,{flag:'wx'});
  }catch(e){r.result=e?.message==='quota_blocked'?'quota_blocked':'source_error';r.status=Number.isInteger(e?.status)?e.status:null;break;}
 }
 report.opendotaStats=client.requestStats;
 const r={provider:'stratz',requestedAt:new Date().toISOString(),knownAt:null,attempts:0};report.requests.push(r);
 const quota=new RoleProfileRepository(db);
 try{
  assert(token,'not_configured');assert.equal(await quota.claimStratz(),0,'quota_blocked');
  const type='kind name ofType { kind name ofType { kind name } }';
  const query='query GameplayBoundaryAudit { '+plan.matchIds.map((id,i)=>`m${i}:match(id:${id}){id startDateTime endDateTime durationSeconds}`).join(' ')+
   ' '+['MatchType','MatchStatsPickBanType','MatchPlaybackDataType'].map((name,i)=>`t${i}:__type(name:"${name}"){name fields{name description type{${type}}}}`).join(' ')+' }';
  r.query=query;r.attempts=1;
  const response=await fetch('https://api.stratz.com/graphql',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json','User-Agent':'STRATZ_API'},body:JSON.stringify({query})});
  r.status=response.status;r.fetchedAt=new Date().toISOString();const now=Date.now(),retry=retryAfterMilliseconds(response.headers.get('retry-after'),now);
  const zero=unit=>response.headers.get('x-ratelimit-remaining-'+unit)==='0';
  await quota.blockStratz(Math.max(response.status===429?retry??60000:response.status>=500?retry??10000:0,
   zero('second')?1000:0,zero('minute')?60000:0,zero('hour')?3600000-now%3600000:0,zero('day')?86400000-now%86400000:0));
  if(!response.ok){await response.body?.cancel();throw Error('http');}
  const body=await boundedBody(response,4194304,[token,key]),data=JSON.parse(body);
  r.file='stratz.json';r.sha256=hash(body);r.result=data.errors?.length?'graphql_error':'captured';await writeFile(dir+'/'+r.file,body,{flag:'wx'});
 }catch{r.result='unavailable';}
}finally{
 report.finishedAt=new Date().toISOString();await writeFile(dir+'/receipts.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});await db.destroy();
 console.log(JSON.stringify({requests:report.requests.map(r=>({provider:r.provider,matchId:r.matchId,status:r.status,result:r.result})),opendotaStats:report.opendotaStats}));
}
