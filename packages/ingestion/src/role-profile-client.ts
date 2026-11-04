import {createHash} from 'node:crypto';
import {CatalogIdSchema,StratzRolePayloadSchema,PandaRolePayloadSchema,RoleProfileObservationSchema,parsePandaRoles,type RoleProfileObservation} from '@dota/contracts';
import {retryAfterMilliseconds} from './opendota/client.js';
export class RoleProfileSourceError extends Error{constructor(readonly code:string,readonly retryMs=60000){super(code);}}
export interface RoleProfileBudget{beforeRequest():Promise<void>;observe(status:number,retryAfterMs:number|null,headers:Headers):Promise<void>}
export class RoleProfileClient{
  constructor(private readonly provider:'stratz'|'pandascore',private readonly token:string,private readonly budget:RoleProfileBudget,
    private readonly fetcher:typeof fetch=fetch,private readonly timeoutMs=10000){
    if(!/^[!-~]+$/.test(token))throw new RoleProfileSourceError('not_configured');
  }
  async read(id:string):Promise<RoleProfileObservation>{
    CatalogIdSchema.parse(id);if(this.provider==='stratz'&&BigInt(id)>4294967295n)throw new RoleProfileSourceError('invalid_id');
    const key=`${this.provider}:${this.provider==='stratz'?'player':'roster'}:${id}`;
    await this.budget.beforeRequest();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const response=await this.fetcher(this.provider==='stratz'?'https://api.stratz.com/graphql':`https://api.pandascore.co/tournaments/${id}/rosters`,{
        method:this.provider==='stratz'?'POST':'GET',redirect:'error',signal:controller.signal,
        headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json',...(this.provider==='stratz'?{'Content-Type':'application/json','User-Agent':'STRATZ_API'}:{})},
        ...(this.provider==='stratz'?{body:JSON.stringify({query:`query RoleProfile { player(steamAccountId:${id}) { steamAccountId steamAccount { proSteamAccount { id name teamId position } } } }`})}:{})});
      const retry=retryAfterMilliseconds(response.headers.get('retry-after'),Date.now());await this.budget.observe(response.status,retry,response.headers);
      if(!response.ok)throw new RoleProfileSourceError(response.status===429?'source_rate_limited':response.status===401||response.status===403?'source_access_denied':'source_http_error',retry??60000);
      if(Number(response.headers.get('content-length')??0)>2097152)throw new RoleProfileSourceError('source_response_too_large');
      const reader=response.body?.getReader();if(!reader)throw new RoleProfileSourceError('source_invalid_json');
      const chunks:Uint8Array[]=[];let bytes=0;
      for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>2097152){await reader.cancel();throw new RoleProfileSourceError('source_response_too_large');}chunks.push(r.value);}
      const text=Buffer.concat(chunks).toString('utf8');if(text.includes(this.token))throw new RoleProfileSourceError('source_invalid_payload');
      let raw:unknown;try{raw=JSON.parse(text);}catch{throw new RoleProfileSourceError('source_invalid_json');}
      let players:RoleProfileObservation['players'];
      if(this.provider==='stratz'){
        const result=StratzRolePayloadSchema.safeParse(raw);if(!result.success)throw new RoleProfileSourceError('source_schema_invalid');
        if(result.data.errors?.length)throw new RoleProfileSourceError('source_graphql_error');
        if(!result.data.data)throw new RoleProfileSourceError('source_schema_invalid');
        const p=result.data.data?.player,profile=p?.steamAccount?.proSteamAccount;
        if(p&&String(p.steamAccountId)!==id||profile&&String(profile.id)!==id)throw new RoleProfileSourceError('source_id_mismatch');
        players=profile?[{accountId:id,providerPlayerId:id,providerTeamId:profile.teamId===null?null:String(profile.teamId),name:profile.name,
          roles:profile.position&&/^POSITION_[1-5]$/.test(profile.position)?[Number(profile.position.at(-1))]:[]}]:[];
      }else{
        const result=PandaRolePayloadSchema.safeParse(raw);if(!result.success)throw new RoleProfileSourceError('source_schema_invalid');
        players=result.data.rosters.flatMap(t=>t.players.map(p=>({accountId:null,providerPlayerId:p.id,providerTeamId:t.id,name:p.name,roles:parsePandaRoles(p.role)})));
      }
      return RoleProfileObservationSchema.parse({provider:this.provider,sourceKey:key,knownAt:null,eventAt:null,fetchedAt:new Date().toISOString(),
        payloadSha256:createHash('sha256').update(text).digest('hex'),players});
    }catch(e){if(e instanceof RoleProfileSourceError)throw e;throw new RoleProfileSourceError(controller.signal.aborted?'source_timeout':'source_network_error');}
    finally{clearTimeout(timer);}
  }
}
