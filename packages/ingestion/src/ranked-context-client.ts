import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CatalogIdSchema,RankedContextReceiptSchema,RANKED_CONTEXT_POLICY,type RankedContextReceipt,type RankedContextSourceEntry} from '@dota/contracts';
import {RankedPracticeSourceError} from './ranked-practice-client.js';
import {retryAfterMilliseconds} from './opendota/client.js';
import type {RoleProfileBudget} from './role-profile-client.js';
const Int=z.number().int().safe(),Id=z.union([Int.positive(),CatalogIdSchema]).transform(String);
const Row=z.object({id:Id,startDateTime:Int.positive(),endDateTime:Int.nullish(),durationSeconds:Int.positive(),didRadiantWin:z.boolean(),lobbyType:z.string(),gameMode:z.string(),leagueId:Int.nullish(),gameVersionId:Int.nullish(),averageRank:Int.nullish(),
 players:z.array(z.object({steamAccountId:Id,playerSlot:Int,isRadiant:z.boolean(),isVictory:z.boolean().nullish(),heroId:Int.positive(),position:z.string().max(40).nullish()})).max(10)});
const slots=new Set([0,1,2,3,4,128,129,130,131,132]);
function entry(raw:unknown,matchId:string,accountId:string):RankedContextSourceEntry{
 const invalid=(reason:string):RankedContextSourceEntry=>({matchId,status:'invalid',reason,map:null});
 if(raw===null)return {matchId,status:'missing',reason:'source_map_unavailable',map:null};
 const parsed=Row.safeParse(raw);if(!parsed.success)return invalid('invalid_row');const r=parsed.data;
 if(r.id!==matchId)return invalid('map_mismatch');
 if(r.lobbyType!=='RANKED'||r.gameMode!=='ALL_PICK_RANKED')return invalid('not_ranked_all_pick');
 if((r.leagueId??0)!==0)return invalid('league_conflict');
 if(r.players.length!==1||r.players[0]!.steamAccountId!==accountId)return invalid('account_mismatch');
 const p=r.players[0]!,end=r.endDateTime??r.startDateTime+r.durationSeconds,win=p.isRadiant===r.didRadiantWin;
 if(!slots.has(p.playerSlot)||(p.playerSlot<128)!==p.isRadiant)return invalid('invalid_side');
 if(p.isVictory!==null&&p.isVictory!==undefined&&p.isVictory!==win)return invalid('outcome_conflict');
 if(r.durationSeconds>86400||end!==r.startDateTime+r.durationSeconds)return invalid('time_mismatch');
 try{
  const position=p.position&&/^POSITION_[1-5]$/.test(p.position)?p.position:null;
  return {matchId,status:'found',reason:null,map:{matchId,accountId,heroId:String(p.heroId),startedAt:new Date(r.startDateTime*1000).toISOString(),completedAt:new Date(end*1000).toISOString(),
   completionBasis:r.endDateTime===null||r.endDateTime===undefined?'start_plus_duration':'provider_end',side:p.isRadiant?'radiant':'dire',win,
   patchCode:r.gameVersionId&&r.gameVersionId>0?String(r.gameVersionId):null,position,roleBasis:position?'estimated':'unknown',averageRank:r.averageRank&&r.averageRank>0?r.averageRank:null,partySize:null}};
 }catch{return invalid('invalid_row');}
}
/** Public known-ID lookup, separate from Player.matches discovery and professional import. */
export class RankedContextClient{
 constructor(private readonly budget:RoleProfileBudget,private readonly token:string,private readonly fetcher:typeof fetch=fetch,private readonly timeoutMs=15000,private readonly now=()=>Date.now()){
  if(!/^[!-~]{1,4096}$/.test(token))throw new RankedPracticeSourceError('not_configured');
 }
 async lookup(accountId:string,matchIds:readonly string[]):Promise<{receipt:RankedContextReceipt;rawBody:string}>{
  CatalogIdSchema.parse(accountId);if(BigInt(accountId)>4294967295n)throw new RankedPracticeSourceError('invalid_account');
  const ids=z.array(CatalogIdSchema).min(1).max(4).parse(matchIds);if(new Set(ids).size!==ids.length)throw new RankedPracticeSourceError('invalid_map_ids');
  // Validated decimal GraphQL literals preserve BIGINT IDs without Number conversion.
  const fields='id startDateTime endDateTime durationSeconds didRadiantWin lobbyType gameMode leagueId gameVersionId averageRank players(steamAccountId:$account){steamAccountId playerSlot isRadiant isVictory heroId position}',
   query=`query RankedContext($account:Long!){${ids.map((id,i)=>`m${i}:match(id:${id}){${fields}}`).join(' ')}}`;
  await this.budget.beforeRequest();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  try{
   const response=await this.fetcher('https://api.stratz.com/graphql',{method:'POST',redirect:'error',signal:controller.signal,headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'STRATZ_API',Authorization:`Bearer ${this.token}`},body:JSON.stringify({query,variables:{account:Number(accountId)}})});
   const retry=retryAfterMilliseconds(response.headers.get('retry-after'),this.now());await this.budget.observe(response.status,retry,response.headers);
   if(!response.ok){await response.body?.cancel();throw new RankedPracticeSourceError(response.status===429?'source_rate_limited':[401,403].includes(response.status)?'source_access_denied':'source_http_error',retry??60000);}
   const reader=response.body?.getReader();if(!reader)throw new RankedPracticeSourceError('source_invalid_json');const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>2097152)throw new RankedPracticeSourceError('source_response_too_large');chunks.push(c.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
   const rawBody=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks));if(rawBody.includes(this.token))throw new RankedPracticeSourceError('source_invalid_payload');
   let raw:unknown;try{raw=JSON.parse(rawBody);}catch{throw new RankedPracticeSourceError('source_invalid_json');}
   const result=z.object({data:z.record(z.string(),z.unknown()).nullish(),errors:z.array(z.unknown()).optional()}).safeParse(raw);
   if(!result.success)throw new RankedPracticeSourceError('source_schema_invalid');if(result.data.errors?.length)throw new RankedPracticeSourceError('source_graphql_error');if(!result.data.data)throw new RankedPracticeSourceError('source_schema_invalid');
   const entries=ids.map((id,i)=>entry(result.data.data!['m'+i],id,accountId));
   return {rawBody,receipt:RankedContextReceiptSchema.parse({policyVersion:RANKED_CONTEXT_POLICY,provider:'stratz',accountId,knownAt:null,fetchedAt:new Date(this.now()).toISOString(),payloadSha256:createHash('sha256').update(rawBody).digest('hex'),entries})};
  }catch(e){if(e instanceof RankedPracticeSourceError)throw e;throw new RankedPracticeSourceError(controller.signal.aborted?'source_timeout':'source_invalid_payload');}
  finally{clearTimeout(timer);}
 }
}
