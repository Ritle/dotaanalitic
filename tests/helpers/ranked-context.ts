import {RankedPracticeRepository,sql,type Db} from '../../packages/db/src/index.js';
import {RankedPracticeClient} from '../../packages/ingestion/src/ranked-practice-client.js';
import {catalogPlayerId} from './catalog.js';
/** Synthetic ranked-only cohort. Never seed the working database. */
export async function seedRankedContext(db:Db,options:{playerId?:string;accountId?:string;extra?:number;nowSeconds?:number;heroId?:number}={}){
 const playerId=options.playerId??catalogPlayerId,accountId=options.accountId??'1000',extra=options.extra??0,now=options.nowSeconds??Math.floor(Date.now()/1000);
 const rows=Array.from({length:21+extra},(_,i)=>({match_id:990000+i,account_id:Number(accountId),hero_id:options.heroId??1,start_time:now-86400+i*60,duration:1800,player_slot:i%2?128:0,radiant_win:i%3===0,lobby_type:7,game_mode:22,leagueid:0}));
 const captured=await new RankedPracticeClient('opendota',{beforeRequest:async()=>{},observe:async()=>{}},{},async()=>new Response(JSON.stringify(rows))).read(accountId),repository=new RankedPracticeRepository(db);
 await sql`UPDATE ranked_practice_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE source_key=${'opendota:'+accountId}`.execute(db);
 const lease=await repository.claim('opendota',accountId);if(!lease)throw Error('synthetic_context_seed_claim');
 await repository.publish(playerId,'opendota',accountId,lease,captured.observation,captured.rawBodies);const saved=await repository.read('opendota',accountId);return {parentId:saved.id!,accountId,playerId,observation:captured.observation,rows};
}
/** Synthetic per-alias provider response derived from fixture rows, with explicit controls. */
export function rankedContextResponse(query:string,rows:readonly {match_id:number;hero_id:number;start_time:number;duration:number;player_slot:number;radiant_win:boolean}[],accountId='1000'){
 return Object.fromEntries([...query.matchAll(/m(\d+):match\(id:(\d+)\)/g)].map(([,alias,id])=>{
  const m=rows.find(r=>String(r.match_id)===id);return ['m'+alias,m?{id:m.match_id,startDateTime:m.start_time,endDateTime:m.start_time+m.duration,durationSeconds:m.duration,didRadiantWin:m.radiant_win,lobbyType:'RANKED',gameMode:'ALL_PICK_RANKED',leagueId:null,gameVersionId:190,averageRank:null,
   players:[{steamAccountId:Number(accountId),playerSlot:m.player_slot,isRadiant:m.player_slot<128,isVictory:(m.player_slot<128)===m.radiant_win,heroId:m.hero_id,position:'POSITION_2'}]}:null];
 }));
}
