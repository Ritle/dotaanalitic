import {OpenDotaClient} from '../../packages/ingestion/dist/index.js';
/** Explicit synthetic transport for disposable DB/API/browser tests only. */
export function syntheticHistoryProvider(options:{mode?:'ok'|'partial'|'fail';gate?:Promise<void>;onRequest?:()=>void}={}){
  let team='31';
  const summary=(index:number)=>({match_id:String(900000000000n+BigInt(team)*100n+BigInt(index)),start_time:1704067200+index*3600,
    duration:1800,radiant_win:index===0,leagueid:77,radiant:index===0,opposing_team_id:900});
  return new OpenDotaClient({maxRequests:39,attempts:1},{sleep:async()=>undefined,fetch:async url=>{
    options.onRequest?.();
    if(url.pathname.startsWith('/api/teams/')){
      team=url.pathname.split('/')[3]!;await options.gate;
      return options.mode==='fail'?new Response('{}',{status:403}):new Response(JSON.stringify([summary(0),summary(1)]));
    }
    if(url.pathname==='/api/heroes')return new Response(JSON.stringify(Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_history_${i}`,localized_name:`Synthetic hero ${i}`}))));
    if(url.pathname==='/api/leagues')return new Response(JSON.stringify([{leagueid:77,name:'Synthetic history tournament',tier:'professional'}]));
    const index=url.pathname.endsWith(summary(0).match_id)?0:1;
    if(options.mode==='partial'&&index===1)return new Response('{}',{status:503});
    return new Response(JSON.stringify({...summary(index),radiant_team_id:index===0?team:'900',dire_team_id:index===0?'900':team,
      radiant_team:{team_id:index===0?team:'900',name:'Synthetic history radiant'},dire_team:{team_id:index===0?'900':team,name:'Synthetic history dire'},
      players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:300001+i})),picks_bans:null}));
  }});
}
