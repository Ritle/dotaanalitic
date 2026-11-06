import {createHash} from 'node:crypto';
import {OpenDotaClient,type PlayerHistoryProvider} from '../../packages/ingestion/dist/index.js';
/** Synthetic source transport, only for disposable test databases. */
export function syntheticPlayerHistory(options:{onCall?:(name:string)=>void;gate?:Promise<void>;mode?:'ok'|'partial'|'excluded'|'empty';maps?:number;enrichment?:boolean}={}):PlayerHistoryProvider{
 const start=Math.floor(Date.now()/86400000)*86400-86400,summary=(id:string)=>({match_id:id,start_time:start,duration:1000,radiant_win:true,leagueid:'90077'});
 const client=new OpenDotaClient({attempts:1,maxRequests:104},{sleep:async()=>undefined,fetch:async url=>{
  options.onCall?.(url.pathname);if(url.pathname==='/api/heroes')return new Response(JSON.stringify(Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`}))));
  if(url.pathname==='/api/leagues')return new Response(JSON.stringify([{leagueid:'90077',name:'Synthetic league',tier:options.mode==='excluded'?'excluded':'professional'}]));
  if(url.pathname==='/api/proPlayers')return new Response(JSON.stringify(Array.from({length:10},(_,i)=>({account_id:1001+i,steamid:String(76561197960265728n+BigInt(1001+i)),name:'Synthetic '+i}))));
  const id=url.pathname.split('/').at(-1)!;if(options.mode==='partial'&&id==='99000002')return new Response('{}',{status:503});
  return new Response(JSON.stringify({...summary(id),lobby_type:1,radiant_team_id:null,dire_team_id:null,
   ...(options.enrichment?{series_id:90088,series_type:1,radiant_team_id:911,dire_team_id:912,radiant_team:{team_id:911,name:'Synthetic A'},dire_team:{team_id:912,name:'Synthetic B'}}:{}),
   players:Array.from({length:10},(_,i)=>({account_id:1001+i,hero_id:i+1,player_slot:i<5?i:128+i-5})),picks_bans:null}));
 }});
 return {discover:async(accounts,_cutoff,_options,page)=>{options.onCall?.('discover');await options.gate;
  const ids=Array.from({length:options.maps??2},(_,i)=>String(99000000+(options.maps??2)-i));
  const rows=options.mode==='empty'?[]:accounts.flatMap(account=>ids.filter(id=>!page?.cursors[account]||BigInt(id)<BigInt(page.cursors[account]!.matchId)).slice(0,page?.limit??10).map(id=>({...summary(id),account_id:account,tier:'professional',player_slot:Number(account)-1001}))),data={rows,err:null},rawBody=JSON.stringify(data);
  return {data,rawBody,source:{provider:'opendota',endpoint:'/explorer',adapterVersion:'synthetic-player-history-test',fetchedAt:new Date().toISOString(),knownAt:null,payloadSha256:createHash('sha256').update(rawBody).digest('hex'),attempts:1,rateLimitRemaining:{minute:null,day:null,month:null}}};},
  ...(options.enrichment?{getProPlayers:()=>client.getProPlayers()}:{}),getHeroes:()=>client.getHeroes(),getLeagues:()=>client.getLeagues(),getMatchSource:id=>client.getMatchSource(id)};
}
