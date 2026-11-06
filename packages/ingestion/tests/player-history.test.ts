import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {playerHistoryQuery,selectPlayerHistory,validatePlayerHistoryMap,PlayerHistoryRowsSchema} from '../src/player-history.js';
import {OpenDotaPlayerHistoryClient} from '../src/opendota/player-history.js';
const cutoff='2026-01-01T00:00:00.000Z';
const row=(account='1',id='101',slot=0)=>({account_id:account,match_id:id,player_slot:slot,start_time:1767139200,duration:1000,radiant_win:true,leagueid:'9',tier:'professional'});
const observation=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {data,rawBody,source:{provider:'opendota' as const,endpoint,adapterVersion:'synthetic-test',fetchedAt:'2026-01-01T00:00:01.000Z',knownAt:null,payloadSha256:createHash('sha256').update(rawBody).digest('hex'),attempts:1,rateLimitRemaining:{minute:null,day:null,month:null}}};};
const map=()=>({...row(),players:[{account_id:1,player_slot:0,hero_id:1}],lobby_type:1,radiant_team_id:null,dire_team_id:null});
it('builds bounded numeric-only read query, with pro and completion/window filters and no organization condition',()=>{
 const q=playerHistoryQuery(['2','1'],cutoff);expect(q).toContain('(1::bigint),(2::bigint)');expect(q).toContain("l.tier IN ('professional','premium')");expect(q).toContain('LIMIT 10');expect(q).not.toContain('team_id');
 for(const ids of [['1; DROP TABLE matches'],['0'],['4294967296'],['1','1'],[]])expect(()=>playerHistoryQuery(ids,cutoff)).toThrow();
});
it('uses a fixed host, shared attempt budget and validates foreign rows and response bodies',async()=>{
 let calls=0,claims=0;const budget={beforeRequest:async()=>{claims++;},observe:async()=>undefined};
 const client=new OpenDotaPlayerHistoryClient(budget,{},async(url,init)=>{calls++;expect(String(url)).toMatch(/^https:\/\/api.opendota.com\/api\/explorer\?sql=/);expect(init?.redirect).toBe('error');return new Response(JSON.stringify({err:null,rows:[row()]}));});
 const r=await client.discover(['1'],cutoff);expect(r.data.rows[0]?.account_id).toBe('1');expect(r.source.knownAt).toBeNull();expect(claims).toBe(1);expect(calls).toBe(1);
 await expect(client.discover(['1;select 1'],cutoff)).rejects.toThrow();expect(calls).toBe(1);
 for(const raw of [{err:'provider error',rows:[]},{err:null,rows:[row('2')]},{err:null,rows:[{...row(),match_id:9007199254740992}]}]){
  const bad=new OpenDotaPlayerHistoryClient(budget,{},async()=>new Response(JSON.stringify(raw)));await expect(bad.discover(['1'],cutoff)).rejects.toMatchObject({code:'source_schema_invalid'});
 }
});
it('honors long Retry-After without retrying and retries a transient response only once',async()=>{
 let calls=0,waits=0;const budget={beforeRequest:async()=>undefined,observe:async()=>undefined};
 const blocked=new OpenDotaPlayerHistoryClient(budget,{},async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'120'}});},async()=>{waits++;});
 await expect(blocked.discover(['1'],cutoff)).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:120000});expect(calls).toBe(1);expect(waits).toBe(0);
 const retry=new OpenDotaPlayerHistoryClient(budget,{},async()=>{calls++;return calls===2?new Response('{}',{status:503}):new Response('{"rows":[],"err":null}');},async()=>{waits++;});
 expect((await retry.discover(['1'],cutoff)).source.attempts).toBe(2);expect(calls).toBe(3);expect(waits).toBe(1);
});
it('deduplicates maps across players and selects fairly independent of results',()=>{
 const rows=PlayerHistoryRowsSchema.parse([row(),row('2','101',128),row('1','102'),row('2','103',128)]);
 const selected=selectPlayerHistory(rows,['1','2'],cutoff);expect(selected.map(r=>r.matchId)).toEqual(['102','103','101']);expect(selected.find(r=>r.matchId==='101')!.players).toHaveLength(2);
 expect(selectPlayerHistory(rows.map(r=>({...r,radiant_win:false})),['1','2'],cutoff).map(r=>r.matchId)).toEqual(selected.map(r=>r.matchId));
});
it('rejects foreign accounts, duplicate observations, non-pro, future and unfinished discovery rows',()=>{
 for(const rows of [[row('3')],[row(),row()],[{...row(),tier:'excluded'}],[{...row(),start_time:1767225600}],[{...row(),duration:0}],[{...row(),start_time:1700000000}]])
 expect(()=>selectPlayerHistory(PlayerHistoryRowsSchema.parse(rows),['1'],cutoff)).toThrow();
});
it('allows unknown organizations/patch/draft but requires numeric participant, pro evidence and consistent details',()=>{
 const candidate=selectPlayerHistory(PlayerHistoryRowsSchema.parse([row()]),['1'],cutoff)[0]!;
 const leagues=[{leagueid:'9',tier:'professional'}];
 expect(validatePlayerHistoryMap(candidate,observation('/matches/101',map()),leagues,cutoff).reasons).toEqual([]);
 for(const change of [{players:[]},{players:[{account_id:2,player_slot:0,hero_id:1}]},{players:[{account_id:1,player_slot:128,hero_id:1}]},{radiant_win:false},{duration:1001},{start_time:1767225600},{leagueid:'10'},{lobby_type:7}])
 expect(validatePlayerHistoryMap(candidate,observation('/matches/101',{...map(),...change}),leagues,cutoff).reasons.length).toBeGreaterThan(0);
 expect(validatePlayerHistoryMap(candidate,observation('/matches/101',map()),[{leagueid:'9',tier:'excluded'}],cutoff).reasons).toContain('PRO_LEAGUE_REQUIRED');
 const damaged=observation('/matches/101',map());damaged.rawBody+=' ';expect(()=>validatePlayerHistoryMap(candidate,damaged,leagues,cutoff)).toThrow();
});
