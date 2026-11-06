import {expect,test} from 'vitest';
import {selectRankedContextMaps,rankedContextConflict} from '../src/ranked-context.js';
const map={matchId:'1',accountId:'1000',heroId:'1',startedAt:'2026-10-01T00:00:00.000Z',completedAt:'2026-10-01T01:00:00.000Z',side:'radiant' as const,win:true};
test('selects latest20 deterministically without mutating or increasing the original cohort',()=>{
 const input=Array.from({length:24},(_,i)=>({...map,matchId:String(i+1),startedAt:new Date(Date.parse(map.startedAt)+i*86400000).toISOString()})),before=structuredClone(input);
 const selected=selectRankedContextMaps(input);expect(selected).toHaveLength(20);expect(selected[0]?.matchId).toBe('24');expect(selected.at(-1)?.matchId).toBe('5');expect(selectRankedContextMaps([...input].reverse())).toEqual(selected);expect(input).toEqual(before);
});
test('empty scope and bigint tie-breaking are safe; duplicate source IDs are rejected',()=>{
 expect(selectRankedContextMaps([])).toEqual([]);expect(selectRankedContextMaps([{...map,matchId:'9007199254740993'},{...map,matchId:'9007199254740992'}]).map(m=>m.matchId)).toEqual(['9007199254740992','9007199254740993']);
 expect(()=>selectRankedContextMaps([map,map])).toThrow('duplicate_ranked_map');
});
test('metadata may differ but every identity/core field must match the saved map',()=>{
 const withMetadata={...map,position:'POSITION_2'};expect(rankedContextConflict(map,withMetadata)).toBeNull();
 for(const [change,reason] of [[{matchId:'2'},'map_mismatch'],[{accountId:'1001'},'account_mismatch'],[{heroId:'2'},'hero_mismatch'],[{side:'dire'},'side_mismatch'],[{win:false},'outcome_conflict'],[{startedAt:'2026-10-02T00:00:00.000Z'},'time_mismatch'],[{completedAt:'2026-10-01T02:00:00.000Z'},'time_mismatch']] as const)expect(rankedContextConflict(map,{...map,...change})).toBe(reason);
});
