import {expect,test} from 'vitest';
import {rankedHeroSummary,type RankedHeroMap} from '../src/ranked-practice.js';
const scope={accountId:'1000',fromAt:'2026-10-01T00:00:00.000Z',cutoffAt:'2026-10-31T00:00:00.000Z'};
const map=(extra:Partial<RankedHeroMap>={}):RankedHeroMap=>({matchId:'1',accountId:'1000',heroId:'1',startedAt:'2026-10-02T00:00:00.000Z',completedAt:'2026-10-02T01:00:00.000Z',win:true,...extra});
test('empty observed cohort has null rate and recency',()=>{
 expect(rankedHeroSummary([],scope)).toEqual({policyVersion:'ranked-hero-raw-v1',roleScope:'all_roles',weighted:false,games:0,wins:0,winRate:null,lastPlayedAt:null,heroes:[]});
});
test('groups raw outcomes once per map, conserves totals and uses latest start independent of input order',()=>{
 const maps=[map({matchId:'3',heroId:'2',win:false}),map({matchId:'2',startedAt:'2026-10-03T00:00:00.000Z',completedAt:'2026-10-03T01:00:00.000Z',win:false}),map()],before=structuredClone(maps);
 const result=rankedHeroSummary(maps,scope);
 expect(result).toMatchObject({games:3,wins:1,winRate:1/3,lastPlayedAt:'2026-10-03T00:00:00.000Z',heroes:[{heroId:'1',games:2,wins:1,winRate:0.5,lastPlayedAt:'2026-10-03T00:00:00.000Z'},{heroId:'2',games:1,wins:0,winRate:0}]});
 expect(rankedHeroSummary([...maps].reverse(),scope)).toEqual(result);expect(maps).toEqual(before);
});
test('observed all-loss and all-win rates differ from missing history',()=>{
 expect(rankedHeroSummary([map({win:false})],scope).winRate).toBe(0);expect(rankedHeroSummary([map()],scope).winRate).toBe(1);
});
test('duplicate map IDs including conflicting outcomes cannot inflate samples',()=>{
 for(const win of [true,false])expect(()=>rankedHeroSummary([map(),map({win})],scope)).toThrow('duplicate_ranked_map');
});
test('wrong account and missing hero cannot enter this player cohort',()=>{
 for(const extra of [{accountId:'1001'},{heroId:'0'},{heroId:''}])expect(()=>rankedHeroSummary([map(extra)],scope)).toThrow('invalid_ranked_map');
});
test('window start is inclusive, starts and completions at cutoff are excluded',()=>{
 expect(rankedHeroSummary([map({startedAt:scope.fromAt})],scope).games).toBe(1);
 for(const extra of [{startedAt:'2026-09-30T23:59:59.999Z'},{startedAt:scope.cutoffAt},{completedAt:scope.cutoffAt},{completedAt:'2026-10-02T00:00:00.000Z'},{startedAt:'invalid'}])expect(()=>rankedHeroSummary([map(extra)],scope)).toThrow('invalid_ranked_map');
 expect(()=>rankedHeroSummary([],{...scope,fromAt:scope.cutoffAt})).toThrow('invalid_ranked_scope');
});
test('equal-size hero groups sort deterministically without losing bigint precision',()=>{
 const result=rankedHeroSummary([map({heroId:'9007199254740993'}),map({matchId:'2',heroId:'9007199254740992'})],scope);
 expect(result.heroes.map(h=>h.heroId)).toEqual(['9007199254740992','9007199254740993']);
});
