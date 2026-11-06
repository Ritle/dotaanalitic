import {it,expect} from 'vitest';
import {playerHistoryQuery,selectPlayerHistory,readPlayerHistoryDiscovery,type PlayerHistoryRow} from '../src/player-history.js';
import {playerHistoryKey} from '@dota/db';
import {SelectedPlayerHistoryRequestSchema} from '@dota/contracts';
const cutoff='2026-11-04T20:00:00.000Z',options={windowDays:365 as const,maxMaps:25 as const};
const row=(index:number,account='1'):PlayerHistoryRow=>({account_id:account,match_id:String(1000-index),start_time:1793000000-index*3600,duration:1000,radiant_win:true,leagueid:'9',player_slot:0,tier:'professional'});
it('accepts only bounded period/depth choices and keeps legacy defaults',()=>{
 const playerIds=['1','2','3','4','5'];expect(SelectedPlayerHistoryRequestSchema.parse({playerIds})).toMatchObject({windowDays:90,maxMaps:10});
 expect(SelectedPlayerHistoryRequestSchema.parse({playerIds,...options})).toMatchObject(options);
 for(const bad of [{windowDays:0},{windowDays:10000},{maxMaps:1000},{maxMaps:11}])expect(()=>SelectedPlayerHistoryRequestSchema.parse({playerIds,...bad})).toThrow();
});
it('separates cache keys by period/depth and preserves the old default key',()=>{
 const bindings=['1','2','3','4','5'].map(id=>({playerId:id,accountId:id})),old=playerHistoryKey(bindings);
 expect(playerHistoryKey(bindings,{windowDays:90,maxMaps:10})).toBe(old);expect(playerHistoryKey([...bindings].reverse(),options)).toBe(playerHistoryKey(bindings,options));
 expect(new Set([old,playerHistoryKey(bindings,options),playerHistoryKey(bindings,{...options,maxMaps:50}),playerHistoryKey(bindings,{...options,windowDays:730})]).size).toBe(4);
});
it('includes older pro history only in the explicitly wider window',()=>{
 const old={...row(0),start_time:1770000000};expect(()=>selectPlayerHistory([old],['1'],cutoff)).toThrow();
 expect(selectPlayerHistory([old],['1'],cutoff,options)).toHaveLength(1);
 const query=playerHistoryQuery(['1'],cutoff,options,{limit:10,cursors:{'1':{startTime:1793000000,matchId:'9007199254740993'}}});
 expect(query).toContain('9007199254740993::bigint');expect(query).toContain('LIMIT 10');expect(query).not.toContain('OFFSET');
});
it('reads bounded keyset pages, stops exhausted accounts and deduplicates shared maps',async()=>{
 const calls:{accounts:readonly string[];limit:number;cursors:unknown}[]=[];
 const result=await readPlayerHistoryDiscovery({discover:async(accounts,_cutoff,_options,page)=>{
  calls.push({accounts,limit:page!.limit,cursors:page!.cursors});const index=page!.cursors['1']?1000-Number(page!.cursors['1'].matchId)+1:0;
  return {data:{rows:accounts.flatMap(account=>Array.from({length:account==='2'?2:page!.limit},(_,i)=>row(index+i,account))),err:null},rawBody:'{}',source:{provider:'opendota',endpoint:'/explorer',adapterVersion:'synthetic-test',knownAt:null,fetchedAt:cutoff,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:{minute:null,day:null,month:null}}};
 }},['1','2'],cutoff,options);
 expect(calls.map(c=>[c.accounts,c.limit])).toEqual([[['1','2'],10],[['1'],10],[['1'],5]]);
 expect(result.rows).toHaveLength(27);expect(result.limitReached).toEqual(['1']);expect(selectPlayerHistory(result.rows,['1','2'],cutoff,options)).toHaveLength(25);
});
it('rejects repeated, reversed and out-of-scope pages before requesting map details',async()=>{
 for(const mode of ['duplicate','reversed','foreign']){let n=0;
  const provider={discover:async()=>{n++;const rows=Array.from({length:10},(_,i)=>row(mode==='duplicate'?i:(n-1)*10+i,mode==='foreign'?'3':'1'));if(mode==='reversed')rows.reverse();
   return {data:{rows,err:null},rawBody:'{}',source:{provider:'opendota' as const,endpoint:'/explorer',adapterVersion:'synthetic-test',knownAt:null,fetchedAt:cutoff,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:{minute:null,day:null,month:null}}};}};
  await expect(readPlayerHistoryDiscovery(provider,['1'],cutoff,options)).rejects.toThrow();expect(n).toBeLessThanOrEqual(2);
 }
});
it('uses numeric IDs to break equal-time ties and obeys a 50-map cap across five accounts',()=>{
 const rows=Array.from({length:50},(_,i)=>({...row(i),start_time:1793000000,match_id:String(9007199254740993n+BigInt(i))}));
 const r=selectPlayerHistory(rows,['1'],cutoff,{windowDays:365,maxMaps:50});expect(r).toHaveLength(50);expect(r[0]?.matchId).toBe('9007199254741042');
 expect(()=>playerHistoryQuery(['1'],cutoff,options,{limit:11,cursors:{}})).toThrow();
 expect(()=>playerHistoryQuery(['1'],cutoff,options,{limit:10,cursors:{'2':{startTime:1,matchId:'1'}}})).toThrow();
});
