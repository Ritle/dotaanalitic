import {test,expect} from 'vitest';
import {ImportJobSchema} from '../src/queue.js';
test('jobs accept a canonical decimal map ID and reject caller-supplied labels/fixtures',()=>{
  expect(ImportJobSchema.parse({matchId:'9007199254740993'})).toEqual({matchId:'9007199254740993'});
  for(const data of [{matchId:'1',radiant_win:true},{matchId:'1',isPro:true},{matchId:'1',fixture:'anything'},
    {matchId:'../teams/1'},{matchId:9007199254740992}])expect(ImportJobSchema.safeParse(data).success).toBe(false);
});
