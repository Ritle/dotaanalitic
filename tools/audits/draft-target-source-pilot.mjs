/** Bounded source experiment. Writes receipts and quota only, never canonical facts. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const PLAN_SHA='cb76f6ccbd55f7de48ae54612cc262f51c1263840843cf6d394ff1ad8e7e0c5a';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const safeId=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):
  typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)?value:null;
export const shouldStop=status=>[401,403,429].includes(status)||status>=500;

export async function boundedBody(response,limit,secrets=[]){
  assert(response.body,'missing_body');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;
    assert(size<=limit,'response_too_large');chunks.push(item.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const body=Buffer.concat(chunks),text=body.toString('utf8');
  assert(!secrets.some(secret=>secret&&text.includes(secret)),'unsafe_payload');
  JSON.parse(text);return body;
}

export function firstGameId(payload){
  if(!Array.isArray(payload?.games)||payload.games.length>20)return null;
  // Transport order selects ONE probe only. It does not establish a map ordinal.
  return payload.games.map(game=>safeId(game?.id)).find(Boolean)??null;
}

export function stratzQuery(ids){
  assert(ids.length===3&&new Set(ids).size===3&&ids.every(id=>safeId(id)===id));
  return 'query DraftTargetSourcePilot { '+ids.map((id,i)=>
    `m${i}: match(id:${id}) { id seriesId startDateTime endDateTime series { id matches { id seriesId startDateTime endDateTime } } }`).join(' ')+' }';
}

async function collect(){
  assert(process.argv.length===2,'no_arguments');
  const bytes=await readFile('.tools/s304-source-pilot-plan-r1.json');assert.equal(sha(bytes),PLAN_SHA);
  const plan=JSON.parse(bytes),dir='.tools/s304-source-pilot-r1';
  // The directory is an attempt lock. A failed/interrupted experiment cannot silently retry.
  await mkdir(dir);
  const {createDatabase,PandaScoreQuotaRepository,RoleProfileRepository}=await import('../../packages/db/dist/index.js');
  const {DurablePandaScoreBudget}=await import('../../apps/api/dist/modules/upcoming/service.js');
  const {retryAfterMilliseconds}=await import('../../packages/ingestion/dist/index.js');
  const {readConfig}=await import('../../apps/api/dist/config.js');
  const config=readConfig(),db=createDatabase(config.DATABASE_URL);
  const panda=new DurablePandaScoreBudget(new PandaScoreQuotaRepository(db)),stratz=new RoleProfileRepository(db);
  const report={format:'draft-target-source-pilot-receipts-v1',planSha256:PLAN_SHA,
    codeSha256:sha(await readFile(new URL(import.meta.url))),startedAt:new Date().toISOString(),
    canonicalWrites:0,training:false,deployable:false,requests:[]};
  await writeFile(`${dir}/plan.json`,bytes,{flag:'wx'});
  async function request(provider,endpoint,query=null){
    const receipt={provider,endpoint,query,requestedAt:new Date().toISOString(),knownAt:null,attempts:0};
    report.requests.push(receipt);const index=report.requests.length;
    try{
      const token=provider==='pandascore'?config.PANDASCORE_API_TOKEN:config.STRATZ_API_TOKEN;
      if(!token)throw Error('not_configured');
      if(provider==='pandascore')await panda.beforeRequest();
      else if(await stratz.claimStratz()>0)throw Error('quota_blocked');
      receipt.attempts=1;
      const response=await fetch(provider==='pandascore'?'https://api.pandascore.co'+endpoint:'https://api.stratz.com/graphql',{
        method:query?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{Accept:'application/json',Authorization:'Bearer '+token,...(query?{'Content-Type':'application/json','User-Agent':'STRATZ_API'}:{})},
        ...(query?{body:JSON.stringify({query})}:{})});
      receipt.status=response.status;receipt.headersReceivedAt=new Date().toISOString();
      const now=Date.now(),retry=retryAfterMilliseconds(response.headers.get('retry-after'),now);
      receipt.retryAfterMs=retry;
      if(provider==='pandascore'){
        const raw=response.headers.get('x-rate-limit-remaining'),remaining=raw!==null&&/^\d+$/.test(raw)?Number(raw):null;
        await panda.observe(response.status,retry,remaining);
      }else{
        const zero=unit=>response.headers.get('x-ratelimit-remaining-'+unit)==='0';
        await stratz.blockStratz(Math.max(response.status===429?retry??60000:response.status>=500?retry??10000:0,
          zero('second')?1000:0,zero('minute')?60000:0,zero('hour')?3600000-now%3600000:0,zero('day')?86400000-now%86400000:0));
      }
      if(!response.ok){await response.body?.cancel();throw Error('source_http_error');}
      const body=await boundedBody(response,2*1024*1024,[config.PANDASCORE_API_TOKEN,config.STRATZ_API_TOKEN]);
      receipt.fetchedAt=new Date().toISOString();receipt.bodySha256=sha(body);receipt.bodyFile=`response-${index}.json`;
      await writeFile(`${dir}/${receipt.bodyFile}`,body,{flag:'wx'});
      const data=JSON.parse(body);receipt.result=data.errors?.length?'graphql_error':'captured';
      return data.errors?.length?null:data;
    }catch(error){
      const allowed=['not_configured','quota_blocked','source_http_error','response_too_large','unsafe_payload'];
      receipt.result=allowed.includes(error.message)?error.message:'source_or_runtime_error';return null;
    }finally{await writeFile(`${dir}/receipt-${index}.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}
  }
  try{
    let gameId=null,stopped=false;
    for(const item of plan.pandaSample){
      const payload=await request('pandascore',`/matches/${item.id}`);
      if(payload&&!gameId)gameId=firstGameId(payload);
      const last=report.requests.at(-1);if(!payload||shouldStop(last.status)){stopped=true;break;}
    }
    if(!stopped&&gameId)await request('pandascore',`/dota2/games/${gameId}`);
    await request('stratz','/graphql',stratzQuery(plan.stratzSample));
  }finally{
    report.finishedAt=new Date().toISOString();
    const output=JSON.stringify(report,null,2)+'\n';await writeFile(`${dir}/receipts.json`,output,{flag:'wx'});
    await db.destroy();
    console.log(JSON.stringify({sha256:sha(output),requests:report.requests.map(r=>({provider:r.provider,attempts:r.attempts,status:r.status??null,result:r.result}))}));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)collect().catch(()=>{
  console.error('Пилот остановлен. Проверьте план, сборку, конфигурацию и новый каталог результата. Повторные запросы запрещены.');process.exitCode=1;
});
