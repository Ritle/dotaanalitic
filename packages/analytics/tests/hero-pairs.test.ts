import {test,expect} from 'vitest';
import {pairObservations,type HeroPairMap} from '../src/hero-pairs.js';
const map:HeroPairMap={matchId:'9007199254740993',radiantWin:true,heroes:[{heroId:1,side:'dire'},{heroId:2,side:'dire'},{heroId:3,side:'radiant'}]};
test('unordered ally pair counts a map once with native-side outcome',()=>{
  expect(pairObservations([map],'ally',1,2)).toEqual([{map,won:false}]);expect(pairObservations([map],'ally',2,1)).toEqual(pairObservations([map],'ally',1,2));
});
test('enemy directions use opposite outcomes and ignore participant array ordering',()=>{
  expect(pairObservations([map],'enemy',1,3)[0]?.won).toBe(false);expect(pairObservations([map],'enemy',3,1)[0]?.won).toBe(true);
  expect(pairObservations([{...map,heroes:[...map.heroes].reverse()}],'enemy',1,3)[0]?.won).toBe(false);
});
test('missing/opposite relation has no observation and duplicate maps/ambiguous heroes reject',()=>{
  expect(pairObservations([map],'ally',1,3)).toHaveLength(0);expect(pairObservations([map],'enemy',1,4)).toHaveLength(0);
  expect(()=>pairObservations([map,map],'ally',1,2)).toThrow('duplicate_pair_map');
  expect(()=>pairObservations([{...map,heroes:[...map.heroes,map.heroes[0]!]}],'ally',1,2)).toThrow('ambiguous_pair_heroes');
});
