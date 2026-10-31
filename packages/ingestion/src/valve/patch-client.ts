import {createHash} from 'node:crypto';
import {z} from 'zod';
import {retryAfterMilliseconds} from '../opendota/client.js';
import {SteamEventResponseSchema} from './steam-event.js';
export const VALVE_PATCH_ADAPTER='valve-patch-audit-v1';
export const PatchLabelSchema=z.string().regex(/^\d{1,2}\.\d{1,2}[a-z]?$/);
const Seconds=z.number().int().min(1).max(253402300799);
const Patch=z.object({patch_number:PatchLabelSchema,patch_timestamp:Seconds});
const List=z.object({success:z.literal(true),patches:z.array(Patch).min(1).max(2000)}).superRefine((r,c)=>{
  if(new Set(r.patches.map(p=>p.patch_number)).size!==r.patches.length)c.addIssue({code:'custom',message:'Duplicate patch labels'});
});
const Note=z.object({note:z.string()});
const Notes=Patch.extend({success:z.literal(true),heroes:z.array(z.object({hero_id:z.number().int().positive().max(2147483647),
  hero_notes:z.array(Note).optional(),abilities:z.array(z.object({ability_id:z.number().int().positive(),ability_notes:z.array(Note).optional()})).optional()})).max(500)});
const News=z.object({appnews:z.object({appid:z.literal(570),newsitems:z.array(z.object({gid:z.string().regex(/^\d{1,20}$/),
  title:z.string().max(2000),date:Seconds,appid:z.literal(570),feedname:z.string(),author:z.string().optional()})).max(100)})});
const Options=z.object({maxRequests:z.number().int().min(1).max(30).default(12),attempts:z.number().int().min(1).max(3).default(2),
  timeoutMs:z.number().int().min(1).max(60000).default(15000),intervalMs:z.number().int().min(1000).max(30000).default(1000),
  maxWaitMs:z.number().int().min(0).max(30000).default(10000),maxBytes:z.number().int().min(1).max(8*1024*1024).default(2*1024*1024)});
export class ValvePatchError extends Error{
  constructor(readonly code:string,readonly status:number|null=null,readonly retryAfterMs:number|null=null){super('Источник Valve недоступен: '+code);}
}
type Dependencies={fetch?:typeof globalThis.fetch;now?:()=>number;sleep?:(ms:number)=>Promise<void>};
export class ValvePatchClient{
  private readonly options:z.infer<typeof Options>;
  private readonly fetcher:typeof globalThis.fetch;private readonly now:()=>number;private readonly sleep:(ms:number)=>Promise<void>;
  private used=0;private nextAt=0;private tail=Promise.resolve();private statuses:Record<string,number>={};
  constructor(options:z.input<typeof Options>={},deps:Dependencies={}){
    const parsed=Options.safeParse(options);if(!parsed.success)throw new ValvePatchError('invalid_configuration');this.options=parsed.data;
    this.fetcher=deps.fetch??globalThis.fetch;this.now=deps.now??Date.now;this.sleep=deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  }
  get requestStats(){return {attempts:this.used,httpStatuses:{...this.statuses}};}
  getPatchList(){return this.request('https://www.dota2.com/datafeed/patchnoteslist?language=english',List);}
  async getSteamEvent(eventId:string){
    if(!/^[1-9]\d{0,19}$/.test(eventId))throw new ValvePatchError('invalid_event_id');
    const result=await this.request(`https://store.steampowered.com/events/ajaxgetpartnerevent?clan_accountid=3703047&event_gid=${eventId}`,SteamEventResponseSchema);
    if(result.data.event.gid!==eventId)throw new ValvePatchError('source_id_mismatch');return result;
  }
  async getPatchNotes(label:string){
    if(!PatchLabelSchema.safeParse(label).success)throw new ValvePatchError('invalid_patch_label');
    const result=await this.request(`https://www.dota2.com/datafeed/patchnotes?language=english&version=${label}`,Notes);
    if(result.data.patch_number!==label)throw new ValvePatchError('source_id_mismatch');
    if(new Set(result.data.heroes.map(h=>h.hero_id)).size!==result.data.heroes.length)throw new ValvePatchError('duplicate_hero_notes');
    return result;
  }
  getAnnouncements(endDate:number){
    if(!Seconds.safeParse(endDate).success)throw new ValvePatchError('invalid_end_date');
    return this.request(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=100&maxlength=1&enddate=${endDate}&feeds=steam_community_announcements`,News);
  }
  private request<T>(url:string,schema:z.ZodType<T>){
    const operation=this.tail.then(()=>this.perform(url,schema));this.tail=operation.then(()=>undefined,()=>undefined);return operation;
  }
  private async perform<T>(url:string,schema:z.ZodType<T>){
    let last=new ValvePatchError('source_network_error');
    for(let attempt=1;attempt<=this.options.attempts;attempt++){
      const delay=Math.max(0,this.nextAt-this.now());if(delay>this.options.maxWaitMs)throw last.code==='source_network_error'?new ValvePatchError('source_wait_budget_exhausted',null,delay):last;
      if(delay)await this.sleep(delay);
      if(this.used>=this.options.maxRequests)throw new ValvePatchError('request_budget_exhausted');
      this.used++;this.nextAt=this.now()+this.options.intervalMs;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs);
      try{
        // Static official endpoints only. Never follow a redirect to an untrusted host.
        const response=await this.fetcher(url,{redirect:'error',signal:controller.signal,headers:{Accept:'application/json'}});
        this.statuses[response.status]=(this.statuses[response.status]??0)+1;
        if(!response.ok){
          const retryAfterMs=retryAfterMilliseconds(response.headers.get('retry-after'),this.now());await response.body?.cancel();
          const error=new ValvePatchError(response.status===429?'source_rate_limited':'source_http_error',response.status,retryAfterMs);
          if(response.status!==429&&response.status<500)throw error;last=error;
        }else{
          const reader=response.body?.getReader();if(!reader)throw new ValvePatchError('source_invalid_json');
          const chunks:Uint8Array[]=[];let size=0;
          try{while(true){controller.signal.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;
            if(size>this.options.maxBytes)throw new ValvePatchError('source_response_too_large');chunks.push(chunk.value);}}
          finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
          const body=Buffer.concat(chunks);let payload:unknown;
          try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new ValvePatchError('source_invalid_json');}
          const parsed=schema.safeParse(payload);if(!parsed.success)throw new ValvePatchError('source_schema_invalid');
          return {data:parsed.data,source:{url,adapterVersion:VALVE_PATCH_ADAPTER,fetchedAt:new Date(this.now()).toISOString(),knownAt:null,
            payloadSha256:createHash('sha256').update(body).digest('hex'),attempts:attempt}};
        }
      }catch(error){
        if(error instanceof ValvePatchError)throw error;
        last=new ValvePatchError(controller.signal.aborted?'source_timeout':'source_network_error');
      }finally{clearTimeout(timer);}
      const backoff=Math.max(1000*2**(attempt-1),last.retryAfterMs??0);this.nextAt=Math.max(this.nextAt,this.now()+backoff);
      if(attempt===this.options.attempts)throw last;
    }
    throw last;
  }
}
