import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PlayerHistoryOptionsSchema,type PlayerHistoryOptions} from '@dota/contracts';
import {ProviderIdSchema,MatchSourceSchema,type OpenDotaMatch} from './opendota/schemas.js';
import {parseSource,completedObservation,classifyLeague} from './quality.js';
import type {ProviderObservation,OpenDotaClient} from './opendota/client.js';
export const HistoryAccountsSchema=z.array(ProviderIdSchema.refine(v=>BigInt(v)<=4294967295n)).min(1).max(5).refine(a=>new Set(a).size===a.length);
const Time=z.iso.datetime({precision:3}),N=z.number().int().safe().nonnegative();
export const PlayerHistoryRowsSchema=z.array(z.object({account_id:ProviderIdSchema,match_id:ProviderIdSchema,leagueid:ProviderIdSchema,
 start_time:z.union([N,z.string().regex(/^\d+$/).transform(Number).pipe(N)]),duration:N,radiant_win:z.boolean(),
 player_slot:N,tier:z.string()})).max(250);
export type PlayerHistoryRow=z.infer<typeof PlayerHistoryRowsSchema>[number];
export interface PlayerHistoryCandidate{matchId:string;players:PlayerHistoryRow[]}
/** Fixed, bounded read-only query. Inputs are numeric IDs and validated timestamps, never arbitrary SQL. */
export interface HistoryCursor{startTime:number;matchId:string}
export interface HistoryPage{limit:number;cursors:Readonly<Record<string,HistoryCursor>>}
const defaults:PlayerHistoryOptions={windowDays:90,maxMaps:10};
const CursorSchema=z.object({startTime:N,matchId:ProviderIdSchema}).strict();
function validatePage(accounts:readonly string[],page:HistoryPage){
 z.number().int().min(1).max(10).parse(page.limit);
 for(const [id,cursor] of Object.entries(page.cursors)){if(!accounts.includes(id))throw Error('history_cursor_account');CursorSchema.parse(cursor);}
}
export function playerHistoryQuery(input:readonly string[],cutoffAt:string,inputOptions:PlayerHistoryOptions=defaults,page:HistoryPage={limit:10,cursors:{}}){
 const ids=HistoryAccountsSchema.parse(input).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);Time.parse(cutoffAt);
 const options=PlayerHistoryOptionsSchema.parse(inputOptions);validatePage(ids,page);
 const end=Math.floor(Date.parse(cutoffAt)/1000),start=end-options.windowDays*86400;
 const cursors=ids.flatMap(id=>{const c=page.cursors[id];return c?[`(a.account_id<>${id}::bigint OR (m.start_time,m.match_id)<(${c.startTime}::bigint,${c.matchId}::bigint))`]:[];});
 return `SELECT a.account_id::text,h.* FROM (VALUES ${ids.map(id=>`(${id}::bigint)`).join(',')}) a(account_id) CROSS JOIN LATERAL (SELECT m.match_id::text,m.start_time,m.duration,m.radiant_win,m.leagueid::text,l.tier,p.player_slot FROM player_matches p JOIN matches m ON m.match_id=p.match_id JOIN leagues l ON l.leagueid=m.leagueid WHERE p.account_id=a.account_id AND l.tier IN ('professional','premium') AND m.radiant_win IS NOT NULL AND m.duration>0 AND m.start_time>=${start} AND m.start_time+m.duration<${end}${cursors.length?' AND '+cursors.join(' AND '):''} ORDER BY m.start_time DESC,m.match_id DESC LIMIT ${page.limit}) h`;
}
/** One map appearing for five players still consumes one detail call. */
export function selectPlayerHistory(input:readonly PlayerHistoryRow[],accounts:readonly string[],cutoffAt:string,inputOptions:PlayerHistoryOptions=defaults):PlayerHistoryCandidate[]{
 const options=PlayerHistoryOptionsSchema.parse(inputOptions);
 HistoryAccountsSchema.parse(accounts);Time.parse(cutoffAt);const rows=PlayerHistoryRowsSchema.parse(input),end=Math.floor(Date.parse(cutoffAt)/1000),seen=new Set<string>();
 for(const r of rows){const key=r.account_id+':'+r.match_id;
  if(!accounts.includes(r.account_id)||seen.has(key)||!['professional','premium'].includes(r.tier)||r.duration<=0||r.start_time<end-options.windowDays*86400||
   r.start_time+r.duration>=end||![0,1,2,3,4,128,129,130,131,132].includes(r.player_slot))throw new Error('player_history_discovery_conflict');seen.add(key);
 }
 const lists=accounts.map(account=>rows.filter(r=>r.account_id===account).sort((a,b)=>b.start_time-a.start_time||(BigInt(a.match_id)>BigInt(b.match_id)?-1:1)));
 if(lists.some(l=>l.length>options.maxMaps))throw new Error('player_history_discovery_bound');
 const chosen:PlayerHistoryCandidate[]=[],ids=new Set<string>();
 for(let rank=0;rank<options.maxMaps&&chosen.length<options.maxMaps;rank++)for(const list of lists){const r=list[rank];if(!r||ids.has(r.match_id)||chosen.length>=options.maxMaps)continue;
  ids.add(r.match_id);chosen.push({matchId:r.match_id,players:rows.filter(p=>p.match_id===r.match_id)});
 }
 return chosen;
}
export function validatePlayerHistoryMap(candidate:PlayerHistoryCandidate,observation:ProviderObservation<unknown>,leagues:readonly {leagueid:string;tier?:string|null}[],cutoffAt:string){
 if(observation.source.endpoint!==`/matches/${candidate.matchId}`||createHash('sha256').update(observation.rawBody).digest('hex')!==observation.source.payloadSha256||
  observation.source.knownAt!==null||observation.source.fetchedAt<cutoffAt)throw new Error('player_history_source_binding');
 const raw:unknown=JSON.parse(observation.rawBody);if(raw&&typeof raw==='object'&&('synthetic' in raw||'_fixture' in raw))throw new Error('player_history_synthetic_source');
 const parsed=parseSource({...observation,data:MatchSourceSchema.parse(raw)},candidate.matchId),m=parsed.match,reasons:string[]=[];
 if(!m)reasons.push('SOURCE_SCHEMA_INVALID');else{
  const league=leagues.filter(l=>l.leagueid===m.leagueid);
  if(league.length!==1||classifyLeague(league[0]?.tier)!==true)reasons.push('PRO_LEAGUE_REQUIRED');
  if(!completedObservation(m,cutoffAt)||typeof m.radiant_win!=='boolean')reasons.push('COMPLETED_OUTCOME_REQUIRED');
  if(m.lobby_type!==1)reasons.push('TOURNAMENT_LOBBY_REQUIRED');
  if(candidate.players.some(p=>p.leagueid!==m.leagueid||p.start_time!==m.start_time||p.duration!==m.duration||p.radiant_win!==m.radiant_win))reasons.push('DISCOVERY_DETAIL_CONFLICT');
  if(candidate.players.some(p=>{const same=m.players?.filter(slot=>slot.account_id===p.account_id)??[];return same.length!==1||same[0]?.player_slot!==p.player_slot;}))reasons.push('PLAYER_PARTICIPATION_REQUIRED');
 }
 return {candidate,observation,match:m as OpenDotaMatch|null,eligible:reasons.length===0,reasons};
}
export type PlayerHistoryProvider=Pick<OpenDotaClient,'getHeroes'|'getLeagues'|'getMatchSource'>&{
 getProPlayers?:OpenDotaClient['getProPlayers'];getPlayer?:OpenDotaClient['getPlayer'];
 discover(accounts:readonly string[],cutoffAt:string,options?:PlayerHistoryOptions,page?:HistoryPage):Promise<ProviderObservation<{rows:PlayerHistoryRow[];err:null}>>;
};
export function validatePlayerHistoryPage(rows:readonly PlayerHistoryRow[],accounts:readonly string[],cutoffAt:string,options:PlayerHistoryOptions,page:HistoryPage){
 validatePage(accounts,page);selectPlayerHistory(rows,accounts,cutoffAt,options);
 for(const account of accounts){const list=rows.filter(r=>r.account_id===account);if(list.length>page.limit)throw Error('history_page_bound');let cursor=page.cursors[account];
  for(const r of list){if(cursor&&(r.start_time>cursor.startTime||r.start_time===cursor.startTime&&BigInt(r.match_id)>=BigInt(cursor.matchId)))throw Error('history_page_order');cursor={startTime:r.start_time,matchId:r.match_id};}
 }
}
export async function readPlayerHistoryDiscovery(provider:Pick<PlayerHistoryProvider,'discover'>,accounts:readonly string[],cutoffAt:string,inputOptions:PlayerHistoryOptions=defaults){
 const options=PlayerHistoryOptionsSchema.parse(inputOptions);HistoryAccountsSchema.parse(accounts);
 const rows:PlayerHistoryRow[]=[],observations:ProviderObservation<{rows:PlayerHistoryRow[];err:null}>[]=[],cursors:Record<string,HistoryCursor>={};
 let active=[...accounts];const limitReached:string[]=[];
 for(let offset=0;offset<options.maxMaps&&active.length;offset+=10){
  const page={limit:Math.min(10,options.maxMaps-offset),cursors:Object.fromEntries(active.flatMap(a=>cursors[a]?[[a,cursors[a]]]:[]))};
  const observation=await provider.discover(active,cutoffAt,options,page);validatePlayerHistoryPage(observation.data.rows,active,cutoffAt,options,page);
  rows.push(...observation.data.rows);selectPlayerHistory(rows,accounts,cutoffAt,options);observations.push(observation);
  const next:string[]=[];for(const account of active){const list=observation.data.rows.filter(r=>r.account_id===account),last=list.at(-1);
   if(last)cursors[account]={startTime:last.start_time,matchId:last.match_id};
   if(list.length===page.limit){if(offset+page.limit>=options.maxMaps)limitReached.push(account);else next.push(account);}
  }active=next;
 }
 return {rows,observations,limitReached};
}
export async function capturePlayerHistory(provider:PlayerHistoryProvider,accounts:readonly string[],cutoffAt=new Date().toISOString(),options:PlayerHistoryOptions=defaults){
 const discovery=await readPlayerHistoryDiscovery(provider,accounts,cutoffAt,options),candidates=selectPlayerHistory(discovery.rows,accounts,cutoffAt,options);
 const leagues=await provider.getLeagues(),heroes=await provider.getHeroes();
 const maps:ReturnType<typeof validatePlayerHistoryMap>[]=[],errors:{matchId:string;code:string}[]=[];
 for(const c of candidates)try{maps.push(validatePlayerHistoryMap(c,await provider.getMatchSource(c.matchId),leagues.data,cutoffAt));}
 catch(e){errors.push({matchId:c.matchId,code:e instanceof Error&&'code' in e&&typeof e.code==='string'?e.code:'source_invalid'});}
 return {cutoffAt,discovery,candidates,leagues,heroes,maps,errors};
}
