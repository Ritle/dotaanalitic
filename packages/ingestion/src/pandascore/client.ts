import {createHash} from 'node:crypto';
import {z} from 'zod';
import {retryAfterMilliseconds} from '../opendota/client.js';
import {PandaIdSchema,PandaUpcomingSchema,PandaRostersSchema,PandaPlayerIdentifierInventorySchema} from './schemas.js';

export type PandaErrorCode='missing_api_token'|'invalid_configuration'|'invalid_id'|'request_budget_exhausted'
  |'source_unauthorized'|'source_forbidden'|'source_rate_limited'|'source_http_error'|'source_network_error'
  |'source_timeout'|'source_response_too_large'|'source_invalid_json'|'source_schema_invalid'|'source_id_mismatch';
export class PandaScoreError extends Error{
  constructor(readonly code:PandaErrorCode,readonly endpoint:string|null=null,readonly status:number|null=null,readonly retryAfterMs:number|null=null){
    super(`Источник PandaScore недоступен: ${code}`);this.name='PandaScoreError';
  }
}
export interface PandaObservation<T>{data:T;source:{provider:'pandascore';adapterVersion:string;endpoint:string;fetchedAt:string;
  knownAt:null;payloadSha256:string;attempts:number;rateLimitRemaining:number|null}}
export interface PandaScoreBudget{beforeRequest():Promise<void>;observe(status:number,retryAfterMs:number|null,remaining:number|null):Promise<void>}
interface Dependencies{fetch?:(url:URL,init:RequestInit)=>Promise<Response>;now?:()=>number;sleep?:(ms:number)=>Promise<void>;budget?:PandaScoreBudget}
const Options=z.object({apiToken:z.string().trim().min(1).max(4096).regex(/^[!-~]+$/),maxRequests:z.number().int().min(1).max(6).default(6),
  timeoutMs:z.number().int().min(1).max(30000).default(15000),maxWaitMs:z.number().int().min(0).max(10000).default(10000)});
/** Fixed host and server-side token; bounded attempts. Runtime callers supply the durable budget. */
export class PandaScoreClient{
  private readonly options:z.output<typeof Options>;
  private readonly fetcher:NonNullable<Dependencies['fetch']>;
  private readonly now:()=>number;private readonly sleep:(ms:number)=>Promise<void>;
  private tail=Promise.resolve();private nextAt=0;private retryAt=0;private used=0;
  private readonly statuses:Record<string,number>={};private readonly transport:Record<string,number>={};
  private readonly budget:PandaScoreBudget|undefined;
  constructor(options:{apiToken?:string;maxRequests?:number;timeoutMs?:number;maxWaitMs?:number},dependencies:Dependencies={}){
    if(!options.apiToken?.trim())throw new PandaScoreError('missing_api_token');
    const parsed=Options.safeParse(options);if(!parsed.success)throw new PandaScoreError('invalid_configuration');
    this.options=parsed.data;this.fetcher=dependencies.fetch??globalThis.fetch;
    this.now=dependencies.now??Date.now;this.sleep=dependencies.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
    this.budget=dependencies.budget;
  }
  get requestStats(){return {attempts:this.used,httpStatuses:{...this.statuses},transportErrors:{...this.transport}};}
  getUpcomingMatches(){return this.request('/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20',PandaUpcomingSchema);}
  getTournamentRosters(id:string){
    const parsed=PandaIdSchema.safeParse(id);if(!parsed.success)throw new PandaScoreError('invalid_id');
    return this.request(`/tournaments/${parsed.data}/rosters`,PandaRostersSchema);
  }
  async getPlayerIdentifierInventory(id:string){
    const parsed=PandaIdSchema.safeParse(id);if(!parsed.success)throw new PandaScoreError('invalid_id');
    const result=await this.request(`/players/${parsed.data}`,PandaPlayerIdentifierInventorySchema);
    if(result.data.providerPlayerId!==parsed.data)throw new PandaScoreError('source_id_mismatch',`/players/${parsed.data}`);
    return result;
  }
  private request<T>(endpoint:string,schema:z.ZodType<T>):Promise<PandaObservation<T>>{
    const task=this.tail.then(()=>this.perform(endpoint,schema));this.tail=task.then(()=>undefined,()=>undefined);return task;
  }
  private async perform<T>(endpoint:string,schema:z.ZodType<T>):Promise<PandaObservation<T>>{
    for(let attempt=1;attempt<=2;attempt++){
      if(this.used>=this.options.maxRequests)throw new PandaScoreError('request_budget_exhausted',endpoint);
      const wait=Math.max(0,this.nextAt-this.now(),this.retryAt-this.now());
      if(wait>this.options.maxWaitMs)throw new PandaScoreError('source_rate_limited',endpoint,null,wait);
      if(wait)await this.sleep(wait);
      await this.budget?.beforeRequest();
      this.used++;this.nextAt=this.now()+4000;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs);
      let retry:PandaScoreError|null=null;
      try{
        const response=await this.fetcher(new URL('https://api.pandascore.co'+endpoint),{method:'GET',redirect:'error',
          headers:{Accept:'application/json',Authorization:`Bearer ${this.options.apiToken}`},signal:controller.signal});
        this.statuses[response.status]=(this.statuses[response.status]??0)+1;
        const header=response.headers.get('x-rate-limit-remaining');
        const remaining=header!==null&&/^\d+$/.test(header)&&Number.isSafeInteger(Number(header))?Number(header):null;
        await this.budget?.observe(response.status,retryAfterMilliseconds(response.headers.get('retry-after'),this.now()),remaining);
        if(!response.ok){
          const delay=retryAfterMilliseconds(response.headers.get('retry-after'),this.now());
          const code=response.status===401?'source_unauthorized':response.status===403?'source_forbidden':response.status===429?'source_rate_limited':'source_http_error';
          await response.body?.cancel();const error=new PandaScoreError(code,endpoint,response.status,delay);
          if(response.status!==429&&response.status<500)throw error;retry=error;
        }else{
          const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
          try{if(reader)while(true){controller.signal.throwIfAborted();const part=await reader.read();if(part.done)break;
            size+=part.value.byteLength;if(size>2*1024*1024)throw new PandaScoreError('source_response_too_large',endpoint);chunks.push(part.value);}
          }finally{await reader?.cancel().catch(()=>undefined);reader?.releaseLock();}
          const bytes=Buffer.concat(chunks);let payload:unknown;
          try{payload=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{throw new PandaScoreError('source_invalid_json',endpoint);}
          const parsed=schema.safeParse(payload);if(!parsed.success)throw new PandaScoreError('source_schema_invalid',endpoint);
          return {data:parsed.data,source:{provider:'pandascore',adapterVersion:'pandascore-schedule-audit-v1',endpoint,
            fetchedAt:new Date(this.now()).toISOString(),knownAt:null,payloadSha256:createHash('sha256').update(bytes).digest('hex'),attempts:attempt,rateLimitRemaining:remaining}};
        }
      }catch(e){
        if(e instanceof PandaScoreError)throw e;
        const code=controller.signal.aborted?'source_timeout':'source_network_error';this.transport[code]=(this.transport[code]??0)+1;
        retry=new PandaScoreError(code,endpoint);
      }finally{clearTimeout(timer);}
      if(!retry)throw new PandaScoreError('source_network_error',endpoint);
      this.retryAt=Math.max(this.retryAt,this.now()+Math.max(4000,retry.retryAfterMs??0));
      if(attempt===2||this.retryAt-this.now()>this.options.maxWaitMs)throw retry;
    }
    throw new PandaScoreError('source_network_error',endpoint);
  }
}
