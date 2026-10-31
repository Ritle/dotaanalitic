import {test,expect} from 'vitest';
import {HeroMatchupQuerySchema,DraftHistoryRequestSchema} from '../src/index.js';
test('pair report requires revision, explicit valid patch scope and finite complete candidate coefficients',()=>{
  expect(HeroMatchupQuerySchema.parse({expectedRevision:1}).patchScope).toBe('all');
  for(const q of [{},{expectedRevision:0},{expectedRevision:1,patchScope:'specific'},{expectedRevision:1,patchId:'1'},{expectedRevision:1,weights:{}},{expectedRevision:1,unknown:true}])expect(HeroMatchupQuerySchema.safeParse(q).success).toBe(false);
});
test('draft-only weights do not require unrelated strength settings; duplicate maps and cutoff reject',()=>{
  const q={cutoffAt:'2024-01-03T00:00:00.000Z',feature:'draft_hero',leagueId:null,heroIds:[1,2],maps:[{matchId:'1',startedAt:'2024-01-02T00:00:00.000Z'}],
    policy:{version:'synthetic',validation:'unvalidated_candidate',draft:{halfLifeDays:30,transitionPenalties:{minor:0,moderate:0,major:0},heroFactors:{unchanged:1,minor:1,moderate:1,major:1,rework:0}}}};
  expect(DraftHistoryRequestSchema.safeParse(q).success).toBe(true);expect(DraftHistoryRequestSchema.safeParse({...q,maps:[...q.maps,...q.maps]}).success).toBe(false);
  expect(DraftHistoryRequestSchema.safeParse({...q,heroIds:[1,1]}).success).toBe(false);expect(DraftHistoryRequestSchema.safeParse({...q,maps:[{matchId:'1',startedAt:q.cutoffAt}]}).success).toBe(false);
});
