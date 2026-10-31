import {test,expect} from 'vitest';
import {DraftInputSchema} from '../src/draft.js';
import {ScenarioInputSchema,ScenarioSnapshotSchema} from '../src/scenario.js';
import {scenarioInput} from '../../../tests/helpers/scenario.js';
const picks=()=>Array.from({length:10},(_,i)=>({teamSlot:i<5?'A' as const:'B' as const,rolePos:i%5+1,heroId:i+1}));
test('empty, partial and ten assigned heroes are valid without timeline or probabilities',()=>{
  for(const assignments of [[],picks().slice(0,3),picks()])expect(DraftInputSchema.safeParse({assignments,bans:[]}).success).toBe(true);
});
test('duplicate role, duplicate cross-side hero, ban/pick overlap and duplicate bans reject',()=>{
  const assignments=picks();
  for(const v of [{assignments:[...assignments,assignments[0]],bans:[]},{assignments:[assignments[0],{...assignments[1],rolePos:1}],bans:[]},
    {assignments:[assignments[0],{...assignments[5],heroId:1}],bans:[]},{assignments,bans:[{teamSlot:'B',heroId:1}]},
    {assignments:[],bans:[{teamSlot:'A',heroId:11},{teamSlot:'B',heroId:11}]}])expect(DraftInputSchema.safeParse(v).success).toBe(false);
});
test('hero IDs must be bounded integers; external evidence and draft order injection reject',()=>{
  for(const heroId of [0,-1,1.5,2147483648,'1'])expect(DraftInputSchema.safeParse({assignments:[{teamSlot:'A',rolePos:1,heroId}],bans:[]}).success).toBe(false);
  expect(DraftInputSchema.safeParse({assignments:[],bans:[],draftOrderValidated:true}).success).toBe(false);
});
test('legacy scenario input and snapshot parse without synthesizing draft or changing hash input',()=>{
  const input=scenarioInput(),copy=ScenarioInputSchema.parse(input);expect(copy).toEqual(input);expect(copy).not.toHaveProperty('draft');expect(copy.context).not.toHaveProperty('leagueId');
  const s={id:'00000000-0000-4000-8000-000000000001',revision:1,input,source:'manual',recordedAt:input.cutoffAt,knownAt:input.cutoffAt,eventAt:null,inputHash:'a'.repeat(64),warnings:['OWNER_ASSERTION_ONLY'],predictionEligibility:'not_assessed'};
  expect(ScenarioSnapshotSchema.parse(s)).toEqual(s);
});
