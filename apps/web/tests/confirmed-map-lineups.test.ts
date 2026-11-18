import {test,expect} from 'vitest';
import {confirmedMapLineups} from '../src/confirmed-map-lineups';
const report=(teamId:string,start:number)=>({teamId,current:{teamId,revision:1,
 lineup:Array.from({length:5},(_,i)=>({rolePos:5-i,playerId:String(9007199254740993n+BigInt(start+i))})),
 confirmedBy:{id:'123e4567-e89b-42d3-a456-426614174000',login:'synthetic-owner'},confirmedAt:'2026-11-12T00:00:00.000Z'},history:[],hasMore:false});
const cutoff='2026-11-12T01:00:00.000Z';
test('copies exact confirmed identities in role order without mutating the templates',()=>{
 const a=report('11',0),b=report('22',5),before=structuredClone(a);
 const result=confirmedMapLineups('11','22',cutoff,a,b)!;
 expect(result.lineupA.map(p=>p.rolePos)).toEqual([1,2,3,4,5]);
 expect(result.lineupA[0]!.playerId).toBe(a.current.lineup[4]!.playerId);
 result.lineupA[0]!.playerId='1';expect(a).toEqual(before);
});
test('rejects missing, stale-team, overlapping and malformed fives',()=>{
 const a=report('11',0),b=report('22',5);
 for(const bad of [undefined,{...a,current:null},{...a,teamId:'33'},{...a,current:{...a.current,teamId:'33'}},
   {...a,current:{...a.current,lineup:a.current.lineup.slice(1)}},
   {...a,current:{...a.current,lineup:a.current.lineup.map(p=>({...p,rolePos:1}))}}])
   expect(confirmedMapLineups('11','22',cutoff,bad,b)).toBeNull();
 expect(confirmedMapLineups('11','22',cutoff,a,report('22',0))).toBeNull();
 expect(confirmedMapLineups('11','11',cutoff,a,a)).toBeNull();
});
test('does not assert a confirmation from after the selected cutoff',()=>{
 expect(confirmedMapLineups('11','22','2026-11-11T23:59:59.999Z',report('11',0),report('22',5))).toBeNull();
 expect(confirmedMapLineups('11','22','invalid',report('11',0),report('22',5))).toBeNull();
});
