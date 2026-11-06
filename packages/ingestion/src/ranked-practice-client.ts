import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CatalogIdSchema,RankedPracticeObservationSchema,RANKED_PRACTICE_ADAPTER_VERSION,type RankedProvider,type RankedPracticeMap,type RankedPracticeObservation} from '@dota/contracts';
import {retryAfterMilliseconds} from './opendota/client.js';
import type {RoleProfileBudget} from './role-profile-client.js';
export class RankedPracticeSourceError extends Error{constructor(readonly code:string,readonly retryMs=60000){super(code);}}
const number=z.number().int().safe(),id=z.union([number.positive(),CatalogIdSchema]).transform(String);
const optionalNumber=number.nullish();
const OdRow=z.object({match_id:id,account_id:id.nullish(),hero_id:number.positive(),start_time:number.positive(),duration:number.positive(),
 player_slot:number,radiant_win:z.boolean(),lobby_type:number,game_mode:number,leagueid:optionalNumber,patch:optionalNumber,
 lane_role:optionalNumber,average_rank:optionalNumber,party_size:optionalNumber});
const StRow=z.object({id,startDateTime:number.positive(),endDateTime:optionalNumber,durationSeconds:number.positive(),didRadiantWin:z.boolean(),
 lobbyType:z.string(),gameMode:z.string(),leagueId:optionalNumber,gameVersionId:optionalNumber,averageRank:optionalNumber,
 players:z.array(z.object({steamAccountId:id,playerSlot:number,isRadiant:z.boolean(),isVictory:z.boolean().nullish(),heroId:number.positive(),
 position:z.string().max(40).nullish()})).max(10)});
const slots=new Set([0,1,2,3,4,128,129,130,131,132]);
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
const query='query RankedPractice($account: Long!, $request: PlayerMatchesRequestType!) { player(steamAccountId: $account) { steamAccountId matches(request: $request) { id startDateTime endDateTime durationSeconds didRadiantWin lobbyType gameMode leagueId gameVersionId averageRank players(steamAccountId: $account) { steamAccountId playerSlot isRadiant isVictory heroId position } } } }';

/** Current descriptive reader. It never supplies pro statistics or V1 features. */
export class RankedPracticeClient{
 constructor(private readonly provider:RankedProvider,private readonly budget:RoleProfileBudget,
  private readonly options:{token?:string;timeoutMs?:number}={},private readonly fetcher:typeof fetch=fetch,private readonly now=()=>Date.now()){
  if(options.token&&!/^[!-~]{1,4096}$/.test(options.token))throw new RankedPracticeSourceError('not_configured');
  if(provider==='stratz'&&!options.token)throw new RankedPracticeSourceError('not_configured');
 }
 async read(accountId:string):Promise<{observation:RankedPracticeObservation;rawBodies:string[]}>{
  CatalogIdSchema.parse(accountId);if(BigInt(accountId)>4294967295n)throw new RankedPracticeSourceError('invalid_account');
  const cutoff=Math.floor(this.now()/1000),from=cutoff-30*86400,rawBodies:string[]=[],receipts:RankedPracticeObservation['receipts']=[];
  const excluded:Record<string,number>={},maps=new Map<string,RankedPracticeMap>(),conflicting=new Set<string>();
  let receivedRows=0,duplicates=0,conflicts=0,pagination:RankedPracticeObservation['coverage']['pagination']='capped',stopReason:string|null=null;
  const exclude=(reason:string)=>{excluded[reason]=(excluded[reason]??0)+1;};
  for(let page=0;page<2;page++){
   let result:{rows:unknown[];raw:string;fetchedAt:string};
   try{result=await this.page(accountId,from,cutoff,page*100);}catch(e){
    if(!receipts.length)throw e;pagination='interrupted';stopReason=e instanceof RankedPracticeSourceError?e.code:'source_unavailable';break;
   }
   rawBodies.push(result.raw);receipts.push({offset:page*100,rows:result.rows.length,fetchedAt:result.fetchedAt,payloadSha256:createHash('sha256').update(result.raw).digest('hex')});
   receivedRows+=result.rows.length;
   for(const raw of result.rows){
    try{
     const map=this.normalize(raw,accountId,from,cutoff);
     if(conflicting.has(map.matchId)){exclude('conflicting_map');continue;}
     const previous=maps.get(map.matchId);
     if(previous){if(JSON.stringify(previous)===JSON.stringify(map)){duplicates++;continue;}maps.delete(map.matchId);conflicting.add(map.matchId);conflicts++;exclude('conflicting_map');continue;}
     maps.set(map.matchId,map);
    }catch(e){exclude(e instanceof RankedPracticeSourceError?e.code:'invalid_row');}
   }
   if(result.rows.length<100){pagination='exhausted';break;}
  }
  return {rawBodies,observation:RankedPracticeObservationSchema.parse({adapterVersion:RANKED_PRACTICE_ADAPTER_VERSION,provider:this.provider,accountId,
   fromAt:iso(from),cutoffAt:iso(cutoff),knownAt:null,fetchedAt:new Date(this.now()).toISOString(),
   filters:{lobbyTypeId:7,gameModeId:22,windowDays:30,qualityFilter:'none'},maps:[...maps.values()].sort((a,b)=>a.matchId.localeCompare(b.matchId)),
   coverage:{receivedRows,excluded,duplicates,conflicts,pagination,historyCompleteness:'unknown',stopReason},receipts})};
 }
 private normalize(raw:unknown,accountId:string,from:number,cutoff:number):RankedPracticeMap{
  let matchId:string,hero:number,start:number,duration:number,end:number,side:boolean,win:boolean,patch:number|null|undefined,position:string|null=null,rank:number|null|undefined,party:number|null=null,completionBasis:'provider_end'|'start_plus_duration'='start_plus_duration';
  if(this.provider==='opendota'){
   const parsed=OdRow.safeParse(raw);if(!parsed.success)throw new RankedPracticeSourceError('invalid_row');const r=parsed.data;
   if(r.account_id&&r.account_id!==accountId)throw new RankedPracticeSourceError('account_mismatch');
   if(r.lobby_type!==7||r.game_mode!==22)throw new RankedPracticeSourceError('not_ranked_all_pick');
   if((r.leagueid??0)!==0)throw new RankedPracticeSourceError('league_conflict');
   if(!slots.has(r.player_slot))throw new RankedPracticeSourceError('invalid_side');
   matchId=r.match_id;hero=r.hero_id;start=r.start_time;duration=r.duration;end=start+duration;side=r.player_slot<128;win=side===r.radiant_win;patch=r.patch;rank=r.average_rank;
   if(r.party_size!==null&&r.party_size!==undefined&&r.party_size>=1&&r.party_size<=5)party=r.party_size;
  }else{
   const parsed=StRow.safeParse(raw);if(!parsed.success)throw new RankedPracticeSourceError('invalid_row');const r=parsed.data;
   if(r.lobbyType!=='RANKED'||r.gameMode!=='ALL_PICK_RANKED')throw new RankedPracticeSourceError('not_ranked_all_pick');
   if((r.leagueId??0)!==0)throw new RankedPracticeSourceError('league_conflict');
   if(r.players.length!==1||r.players[0]!.steamAccountId!==accountId)throw new RankedPracticeSourceError('account_mismatch');
   const p=r.players[0]!;if(!slots.has(p.playerSlot)||(p.playerSlot<128)!==p.isRadiant)throw new RankedPracticeSourceError('invalid_side');
   matchId=r.id;hero=p.heroId;start=r.startDateTime;duration=r.durationSeconds;end=r.endDateTime??start+duration;side=p.isRadiant;win=side===r.didRadiantWin;patch=r.gameVersionId;rank=r.averageRank;
   if(p.isVictory!==null&&p.isVictory!==undefined&&p.isVictory!==win)throw new RankedPracticeSourceError('outcome_conflict');
   if(p.position&&/^POSITION_[1-5]$/.test(p.position))position=p.position;
   if(r.endDateTime!==null&&r.endDateTime!==undefined)completionBasis='provider_end';
  }
  if(start<from||start>=cutoff)throw new RankedPracticeSourceError('outside_window');
  if(duration>86400||end<=start||Math.max(end,start+duration)>=cutoff)throw new RankedPracticeSourceError('not_completed_before_cutoff');
  return {matchId,accountId,heroId:String(hero),startedAt:iso(start),completedAt:iso(end),completionBasis,side:side?'radiant':'dire',win,
   patchCode:patch&&patch>0?String(patch):null,position,roleBasis:position?'estimated':'unknown',averageRank:rank&&rank>0?rank:null,partySize:party};
 }
 private async page(accountId:string,from:number,cutoff:number,offset:number):Promise<{rows:unknown[];raw:string;fetchedAt:string}>{
  await this.budget.beforeRequest();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs??15000);
  try{
   const params=new URLSearchParams({lobby_type:'7',game_mode:'22',significant:'0',date:'31',limit:'100',offset:String(offset),sort:'start_time'});
   // OpenDota uses userFields instead of matchesCols whenever project is present.
   for(const field of ['match_id','player_slot','radiant_win','account_id','hero_id','start_time','duration','lobby_type','game_mode','leagueid','patch','average_rank','party_size'])params.append('project',field);
   const response=await this.fetcher(this.provider==='opendota'?`https://api.opendota.com/api/players/${accountId}/matches?${params}`:'https://api.stratz.com/graphql',{
    method:this.provider==='stratz'?'POST':'GET',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(this.options.token?{Authorization:`Bearer ${this.options.token}`}:{ }),
     ...(this.provider==='stratz'?{'Content-Type':'application/json','User-Agent':'STRATZ_API'}:{})},
    ...(this.provider==='stratz'?{body:JSON.stringify({query,variables:{account:Number(accountId),request:{startDateTime:from,endDateTime:cutoff,lobbyTypeIds:[7],gameModeIds:[22],take:100,skip:offset,orderBy:'DESC',playerList:'SINGLE'}}})}:{})});
   const retry=retryAfterMilliseconds(response.headers.get('retry-after'),this.now());await this.budget.observe(response.status,retry,response.headers);
   if(!response.ok){await response.body?.cancel();throw new RankedPracticeSourceError(response.status===429?'source_rate_limited':[401,403].includes(response.status)?'source_access_denied':'source_http_error',retry??60000);}
   const reader=response.body?.getReader();if(!reader)throw new RankedPracticeSourceError('source_invalid_json');
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>2097152)throw new RankedPracticeSourceError('source_response_too_large');chunks.push(c.value);}}
   finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
   const raw=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks));if(this.options.token&&raw.includes(this.options.token))throw new RankedPracticeSourceError('source_invalid_payload');
   let data:unknown;try{data=JSON.parse(raw);}catch{throw new RankedPracticeSourceError('source_invalid_json');}
   let rows:unknown[];
   if(this.provider==='opendota'){const parsed=z.array(z.unknown()).max(100).safeParse(data);if(!parsed.success)throw new RankedPracticeSourceError('source_schema_invalid');rows=parsed.data;}
   else{
    const parsed=z.object({errors:z.array(z.unknown()).optional(),data:z.object({player:z.object({steamAccountId:id,matches:z.array(z.unknown()).max(100).nullable()}).nullable()}).nullable().optional()}).safeParse(data);
    if(!parsed.success)throw new RankedPracticeSourceError('source_schema_invalid');if(parsed.data.errors?.length)throw new RankedPracticeSourceError('source_graphql_error');
    const p=parsed.data.data?.player;if(!p||p.matches===null)throw new RankedPracticeSourceError('source_player_unavailable');
    if(p.steamAccountId!==accountId)throw new RankedPracticeSourceError('source_id_mismatch');rows=p.matches;
   }
   return {rows,raw,fetchedAt:new Date(this.now()).toISOString()};
  }catch(e){if(e instanceof RankedPracticeSourceError)throw e;throw new RankedPracticeSourceError(controller.signal.aborted?'source_timeout':'source_network_error');}
  finally{clearTimeout(timer);}
 }
}
