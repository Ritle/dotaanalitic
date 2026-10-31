import {test,expect} from 'vitest';
import {ScenarioInputSchema,UpdateScenarioSchema} from '../src/scenario.js';
import {scenarioInput} from '../../../tests/helpers/scenario.js';
test('manual ten canonical IDs retain bigint precision and null side/context',()=>{
  const q=scenarioInput();expect(ScenarioInputSchema.parse(q).teamAId).toBe('9007199254740993');expect(q.context.radiantSlot).toBeNull();
});
test('incomplete/duplicate roles and IDs, unconfirmed input and injected provenance reject',()=>{
  const q=scenarioInput();
  for(const v of [{...q,confirmedByOwner:false},{...q,recordedAt:q.cutoffAt},{...q,teamBId:q.teamAId},
    {...q,lineupB:q.lineupA},{...q,lineupA:q.lineupA.slice(1)},
    {...q,lineupA:q.lineupA.map(p=>({...p,playerId:null}))},
    {...q,lineupA:q.lineupA.map(p=>({...p,rolePos:1}))}])expect(ScenarioInputSchema.safeParse(v).success).toBe(false);
});
test('map score precedes map, both nullable scores supplied together, cutoff before scheduled start',()=>{
  const q=scenarioInput();
  for(const context of [{...q.context,mapNumber:2,teamASeriesWinsBefore:1},{...q.context,mapNumber:2,teamASeriesWinsBefore:1,teamBSeriesWinsBefore:1}])
    expect(ScenarioInputSchema.safeParse({...q,context}).success).toBe(false);
  expect(ScenarioInputSchema.safeParse({...q,scheduledAt:'2023-01-01T00:00:00.000Z'}).success).toBe(false);
  expect(ScenarioInputSchema.safeParse({...q,context:{...q.context,mapNumber:2,teamASeriesWinsBefore:1,teamBSeriesWinsBefore:0,radiantSlot:'B',firstPickSlot:'A'}}).success).toBe(true);
});
test('expected baseline separate, unique across its sides, revision mandatory',()=>{
  const q=scenarioInput();expect(ScenarioInputSchema.parse({...q,expectedLineupA:q.lineupA}).expectedLineupA).toEqual(q.lineupA);
  expect(ScenarioInputSchema.safeParse({...q,expectedLineupA:q.lineupA,expectedLineupB:q.lineupA}).success).toBe(false);
  expect(UpdateScenarioSchema.safeParse({input:q}).success).toBe(false);
});
