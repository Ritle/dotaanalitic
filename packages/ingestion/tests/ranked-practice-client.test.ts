import {expect,test} from 'vitest';
import {RankedPracticeClient} from '../src/ranked-practice-client.js';
const now=Date.parse('2026-11-05T21:00:00.000Z'),cutoff=now/1000;
const row=(change:Record<string,unknown>={})=>({match_id:100,hero_id:1,start_time:cutoff-7200,duration:1800,player_slot:128,radiant_win:false,lobby_type:7,game_mode:22,...change});
const stratz=(change:Record<string,unknown>={})=>({id:100,startDateTime:cutoff-7200,endDateTime:cutoff-5400,durationSeconds:1800,didRadiantWin:false,
 lobbyType:'RANKED',gameMode:'ALL_PICK_RANKED',leagueId:0,gameVersionId:190,averageRank:80,
 players:[{steamAccountId:1000,playerSlot:128,isRadiant:false,isVictory:true,heroId:1,position:'POSITION_4'}],...change});
const budget=()=>({calls:0,statuses:[] as number[],async beforeRequest(){this.calls++;},async observe(status:number){this.statuses.push(status);}});
const client=(payload:unknown,provider:'opendota'|'stratz'='opendota')=>new RankedPracticeClient(provider,budget(),{token:provider==='stratz'?'synthetic-ranked-token':undefined},async()=>new Response(JSON.stringify(payload)),()=>now);
const stPayload=(matches:unknown)=>({data:{player:{steamAccountId:1000,matches}}});

test('ranked reader pins a current window, explicit filters, bounded projected query and source clocks',async()=>{
 const b=budget();let url='';const r=await new RankedPracticeClient('opendota',b,{},async(input)=>{url=String(input);return new Response(JSON.stringify([row({party_size:1,average_rank:80,lane_role:1})]));},()=>now).read('1000');
 const q=new URL(url).searchParams;expect(Object.fromEntries(q)).toMatchObject({lobby_type:'7',game_mode:'22',date:'31',significant:'0',limit:'100',offset:'0'});
 expect(r.observation.maps[0]).toMatchObject({matchId:'100',accountId:'1000',heroId:'1',side:'dire',win:true,position:null,roleBasis:'unknown',partySize:1,averageRank:80});
 expect(r.observation.knownAt).toBeNull();expect(r.observation.coverage).toMatchObject({receivedRows:1,pagination:'exhausted',historyCompleteness:'unknown'});
 expect(r.observation.receipts[0]!.payloadSha256).toMatch(/^[a-f0-9]{64}$/);expect(b.calls).toBe(1);
});
test('OpenDota explicit project replaces defaults: hero, duration and optional context must be requested',async()=>{
 const full=row({account_id:1000,leagueid:0,average_rank:80,party_size:1}),b=budget();
 const result=await new RankedPracticeClient('opendota',b,{},async(input)=>{
  const project=new URL(String(input)).searchParams.getAll('project');
  // Emulate the documented OpenDota route: always/filter columns + explicit user projection.
  const columns=new Set(['match_id','player_slot','radiant_win','lobby_type','game_mode','start_time',...project]);
  return new Response(JSON.stringify([Object.fromEntries(Object.entries(full).filter(([key])=>columns.has(key)))]));
 },()=>now).read('1000');
 expect(result.observation.maps).toHaveLength(1);expect(result.observation.maps[0]).toMatchObject({heroId:'1',completedAt:'2026-11-05T19:30:00.000Z',averageRank:80,partySize:1});
 expect(result.observation.coverage.excluded).toEqual({});
});
test('explicit STRATZ account and side determine outcome, role stays estimated and party remains unknown',async()=>{
 let body:Record<string,unknown>|undefined;
 const r=await new RankedPracticeClient('stratz',budget(),{token:'synthetic-ranked-token'},async(_,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify(stPayload([stratz()])));},()=>now).read('1000');
 expect(JSON.stringify(body)).not.toContain('synthetic-ranked-token');expect(body?.variables).toMatchObject({account:1000,request:{lobbyTypeIds:[7],gameModeIds:[22],take:100,skip:0}});
 expect(r.observation.maps[0]).toMatchObject({side:'dire',win:true,completionBasis:'provider_end',position:'POSITION_4',roleBasis:'estimated',partySize:null,patchCode:'190'});
});
test('empty page is valid observation with unknown completeness, missing player is unavailable',async()=>{
 for(const p of ['opendota','stratz'] as const){const r=await client(p==='opendota'?[]:stPayload([]),p).read('1000');expect(r.observation.maps).toEqual([]);expect(r.observation.coverage.historyCompleteness).toBe('unknown');}
 for(const player of [null,{steamAccountId:1000,matches:null}])await expect(client({data:{player}},'stratz').read('1000')).rejects.toMatchObject({code:'source_player_unavailable'});
});
test('subsecond fetch time is preserved without rounding an observation into the future',async()=>{
 const observedAt=now+123,r=await new RankedPracticeClient('opendota',budget(),{},async()=>new Response('[]'),()=>observedAt).read('1000');
 expect(Date.parse(r.observation.fetchedAt)).toBe(observedAt);expect(Date.parse(r.observation.cutoffAt)).toBe(now);
});
test('current window is inclusive at from, strict at start/end cutoff and excludes future or ongoing maps',async()=>{
 const r=await client([row({match_id:1,start_time:cutoff-30*86400}),row({match_id:2,start_time:cutoff-30*86400-1}),row({match_id:3,start_time:cutoff}),row({match_id:4,start_time:cutoff-1800}),row({match_id:5,start_time:cutoff+1})]).read('1000');
 expect(r.observation.maps.map(m=>m.matchId)).toEqual(['1']);expect(r.observation.coverage.excluded).toEqual({outside_window:3,not_completed_before_cutoff:1});
});
test('unknown modes, Turbo, leagues, invalid native slots, missing outcomes and unsafe IDs are excluded',async()=>{
 const r=await client([row({lobby_type:0}),row({game_mode:23}),row({leagueid:77}),row({player_slot:5}),row({radiant_win:null}),row({match_id:Number.MAX_SAFE_INTEGER+1}),row({account_id:1001})]).read('1000');
 expect(r.observation.maps).toEqual([]);expect(r.observation.coverage.excluded).toEqual({not_ranked_all_pick:2,league_conflict:1,invalid_side:1,invalid_row:2,account_mismatch:1});
});
test('STRATZ duplicate participants, account/slot/outcome conflicts cannot be normalized',async()=>{
 const p=stratz().players[0]!;
 const r=await client(stPayload([stratz({players:[p,p]}),stratz({players:[{...p,steamAccountId:1001}]}),stratz({players:[{...p,isRadiant:true}]}),stratz({players:[{...p,isVictory:false}]})]),'stratz').read('1000');
 expect(r.observation.maps).toEqual([]);expect(r.observation.coverage.excluded).toEqual({account_mismatch:2,invalid_side:1,outcome_conflict:1});
});
test('same map deduplicates once, contradictory observations remove it from usable maps',async()=>{
 const r=await client([row(),row(),row({hero_id:2}),row(),row({match_id:'9223372036854775807',player_slot:0,radiant_win:false})]).read('1000');
 expect(r.observation.maps).toHaveLength(1);expect(r.observation.maps[0]).toMatchObject({matchId:'9223372036854775807',side:'radiant',win:false});expect(r.observation.coverage).toMatchObject({duplicates:1,conflicts:1});
});
test('two full pages stop at hard cap without extra HTTP or duplicate counts as extra maps',async()=>{
 const b=budget(),r=await new RankedPracticeClient('opendota',b,{},async()=>new Response(JSON.stringify(Array.from({length:100},(_,i)=>row({match_id:100+i})))),()=>now).read('1000');
 expect(b.calls).toBe(2);expect(r.observation.maps).toHaveLength(100);expect(r.observation.coverage).toMatchObject({receivedRows:200,duplicates:100,pagination:'capped'});
});
test('failed second page preserves earlier data as interrupted, with no retry',async()=>{
 const b=budget(),r=await new RankedPracticeClient('opendota',b,{},async()=>b.calls===1?new Response(JSON.stringify(Array.from({length:100},(_,i)=>row({match_id:100+i})))):new Response('{}',{status:429,headers:{'Retry-After':'120'}}),()=>now).read('1000');
 expect(b.calls).toBe(2);expect(b.statuses).toEqual([200,429]);expect(r.observation.maps).toHaveLength(100);expect(r.observation.coverage).toMatchObject({pagination:'interrupted',stopReason:'source_rate_limited'});
});
test('GraphQL errors, mismatched account and malformed envelopes are errors rather than empty observations',async()=>{
 for(const [raw,code] of [[{...stPayload([]),errors:[{message:'sensitive detail'}]},'source_graphql_error'],[{data:{player:{steamAccountId:1001,matches:[]}}},'source_id_mismatch'],[{},'source_player_unavailable']] as const)
  await expect(client(raw,'stratz').read('1000')).rejects.toMatchObject({code});
});
test('access denial, oversized response, invalid JSON, timeout and echoed token are sanitized',async()=>{
 for(const [response,code] of [[new Response('{}',{status:403}),'source_access_denied'],[new Response('['+' '.repeat(2097152)+']'),'source_response_too_large'],[new Response('not json'),'source_invalid_json'],[new Response(JSON.stringify({token:'synthetic-ranked-token'})),'source_invalid_payload']] as const){
  await expect(new RankedPracticeClient('stratz',budget(),{token:'synthetic-ranked-token'},async()=>response,()=>now).read('1000')).rejects.toMatchObject({code});
 }
 await expect(new RankedPracticeClient('opendota',budget(),{timeoutMs:1},async(_,init)=>{await new Promise((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(Error('sensitive'))));return new Response();},()=>now).read('1000')).rejects.toMatchObject({code:'source_timeout'});
});
test('invalid account and denied budget cannot consume provider HTTP',async()=>{
 let calls=0;const b=budget(),c=new RankedPracticeClient('opendota',b,{},async()=>{calls++;return new Response('[]');},()=>now);
 await expect(c.read('4294967296')).rejects.toMatchObject({code:'invalid_account'});expect(b.calls).toBe(0);expect(calls).toBe(0);
 await expect(new RankedPracticeClient('opendota',{...b,beforeRequest:async()=>{throw Error('quota');}},{},async()=>{calls++;return new Response('[]');},()=>now).read('1000')).rejects.toThrow('quota');expect(calls).toBe(0);
});
