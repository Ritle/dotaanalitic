import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PlayerHistoryRowsSchema,playerHistoryQuery,validatePlayerHistoryPage,type HistoryPage} from '../player-history.js';
import {PlayerHistoryOptionsSchema,type PlayerHistoryOptions} from '@dota/contracts';
import {OpenDotaError,retryAfterMilliseconds,type ProviderBudget,type ProviderObservation} from './client.js';
const ResponseSchema=z.object({rows:PlayerHistoryRowsSchema,err:z.null()});
/** Separate bounded adapter: the frozen OpenDota match client stays unchanged. */
export class OpenDotaPlayerHistoryClient{
 constructor(private readonly budget:ProviderBudget,private readonly options:{apiKey?:string;timeoutMs?:number}={},
  private readonly fetcher:typeof fetch=fetch,private readonly sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){}
 async discover(accounts:readonly string[],cutoffAt:string,inputOptions:PlayerHistoryOptions={windowDays:90,maxMaps:10},page:HistoryPage={limit:10,cursors:{}}):Promise<ProviderObservation<z.infer<typeof ResponseSchema>>>{
  const options=PlayerHistoryOptionsSchema.parse(inputOptions),query=playerHistoryQuery(accounts,cutoffAt,options,page),endpoint='/explorer?'+new URLSearchParams({sql:query}).toString(),token=this.options.apiKey?.trim();
  if(token&&!/^[!-~]{1,4096}$/.test(token))throw new OpenDotaError('invalid_configuration');
  for(let attempt=1;attempt<=2;attempt++){
   await this.budget.beforeRequest();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs??20000);let retry:OpenDotaError|null=null;
   try{
    const r=await this.fetcher('https://api.opendota.com/api'+endpoint,{method:'GET',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});
    const remaining=(k:string)=>{const v=r.headers.get('x-rate-limit-remaining-'+k);return v!==null&&/^\d+$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;};
    const limits={minute:remaining('minute'),day:remaining('day'),month:remaining('month')},delay=retryAfterMilliseconds(r.headers.get('retry-after'),Date.now());
    await this.budget.observe(r.status,delay,limits);
    if(!r.ok){await r.body?.cancel();const e=new OpenDotaError(r.status===429?'source_rate_limited':'source_http_error','/explorer',r.status,delay);if(r.status!==429&&r.status<500)throw e;retry=e;}
    else{
     const reader=r.body?.getReader();if(!reader)throw new OpenDotaError('source_invalid_json');const chunks:Uint8Array[]=[];let size=0;
     try{for(;;){controller.signal.throwIfAborted();const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>1024*1024)throw new OpenDotaError('source_response_too_large');chunks.push(c.value);}}
     finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
     const bytes=Buffer.concat(chunks);let rawBody:string,raw:unknown;try{rawBody=new TextDecoder('utf8',{fatal:true}).decode(bytes);if(token&&rawBody.includes(token))throw Error();raw=JSON.parse(rawBody);}catch{throw new OpenDotaError('source_invalid_json');}
     const parsed=ResponseSchema.safeParse(raw);if(!parsed.success)throw new OpenDotaError('source_schema_invalid');
     try{validatePlayerHistoryPage(parsed.data.rows,accounts,cutoffAt,options,page);}catch{throw new OpenDotaError('source_schema_invalid');}
     return {data:parsed.data,rawBody,source:{provider:'opendota',adapterVersion:'opendota-player-history-v2',endpoint,knownAt:null,fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(bytes).digest('hex'),attempts:attempt,rateLimitRemaining:limits}};
    }
   }catch(e){if(e instanceof OpenDotaError)throw e;retry=new OpenDotaError(controller.signal.aborted?'source_timeout':'source_network_error','/explorer');}
   finally{clearTimeout(timer);}
   const wait=Math.max(500,retry?.retryAfterMs??0);if(attempt===2||wait>5000)throw retry??new OpenDotaError('source_network_error');await this.sleep(wait);
  }
  throw new OpenDotaError('source_network_error');
 }
}
