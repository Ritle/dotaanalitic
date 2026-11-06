import {createHash} from 'node:crypto';
import {z} from 'zod';
import {TeamSchema} from './schemas.js';
import {OpenDotaError,retryAfterMilliseconds,type ProviderBudget,type ProviderObservation} from './client.js';
export const TeamDirectorySchema=z.array(TeamSchema).max(20000).refine(rows=>new Set(rows.map(r=>r.team_id)).size===rows.length,'Duplicate team ID');
/** Separate metadata adapter; does not alter the frozen match/training client. */
export class OpenDotaTeamDirectoryClient{
 constructor(private readonly budget:ProviderBudget,private readonly options:{apiKey?:string;timeoutMs?:number}={},
  private readonly fetcher:typeof fetch=fetch,private readonly sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){}
 async read():Promise<ProviderObservation<z.infer<typeof TeamDirectorySchema>>>{
  const token=this.options.apiKey?.trim();if(token&&!/^[!-~]{1,4096}$/.test(token))throw new OpenDotaError('invalid_configuration');
  for(let attempt=1;attempt<=2;attempt++){
   await this.budget.beforeRequest();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs??15000);
   let retry:OpenDotaError|null=null;
   try{
    const r=await this.fetcher('https://api.opendota.com/api/teams',{method:'GET',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}});
    const remaining=(key:string)=>{const s=r.headers.get('x-rate-limit-remaining-'+key);return s!==null&&/^\d+$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):null;};
    const limits={minute:remaining('minute'),day:remaining('day'),month:remaining('month')},delay=retryAfterMilliseconds(r.headers.get('retry-after'),Date.now());
    await this.budget.observe(r.status,delay,limits);
    if(!r.ok){await r.body?.cancel();const error=new OpenDotaError(r.status===429?'source_rate_limited':'source_http_error','/teams',r.status,delay);
     if(r.status!==429&&r.status<500)throw error;retry=error;
    }else{
     const reader=r.body?.getReader();if(!reader)throw new OpenDotaError('source_invalid_json','/teams');const chunks:Uint8Array[]=[];let size=0;
     try{for(;;){controller.signal.throwIfAborted();const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>8*1024*1024)throw new OpenDotaError('source_response_too_large','/teams');chunks.push(c.value);}}
     finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
     const bytes=Buffer.concat(chunks);let rawBody:string,raw:unknown;try{rawBody=new TextDecoder('utf8',{fatal:true}).decode(bytes);if(token&&rawBody.includes(token))throw Error();raw=JSON.parse(rawBody);}catch{throw new OpenDotaError('source_invalid_json','/teams');}
     const parsed=TeamDirectorySchema.safeParse(raw);if(!parsed.success)throw new OpenDotaError('source_schema_invalid','/teams');
     return {data:parsed.data,rawBody,source:{provider:'opendota',adapterVersion:'opendota-team-directory-v1',endpoint:'/teams',knownAt:null,fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(bytes).digest('hex'),attempts:attempt,rateLimitRemaining:limits}};
    }
   }catch(e){if(e instanceof OpenDotaError)throw e;retry=new OpenDotaError(controller.signal.aborted?'source_timeout':'source_network_error','/teams');}
   finally{clearTimeout(timer);}
   const wait=Math.max(500,retry?.retryAfterMs??0);if(attempt===2||wait>5000)throw retry??new OpenDotaError('source_network_error','/teams');await this.sleep(wait);
  }
  throw new OpenDotaError('source_network_error','/teams');
 }
}
