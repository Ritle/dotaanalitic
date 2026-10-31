import {test,expect} from 'vitest';
import type {GameRegistry,HeroRuleEvidence} from '@dota/contracts';
import {assessScenarioDraft} from '../src/scenario-draft.js';
import {scenarioInput} from '../../../tests/helpers/scenario.js';
const checked='2026-10-31T00:00:00.000Z';
function registry():GameRegistry{return {revision:'1',draftRules:[],patches:[{id:'1',patchId:'1',releasedAt:'2023-01-01T00:00:00.000Z',coverageUntil:'2025-01-01T00:00:00.000Z',
  eventAt:null,knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:checked,source:'synthetic',evidenceRef:'synthetic:patch',reviewState:'accepted'}],heroRules:[]};}
function rule(overrides:Partial<HeroRuleEvidence>={}){return {id:'2',heroId:1,patchId:'1',leagueId:'1',allowed:true,validFrom:'2023-01-01T00:00:00.000Z',validTo:null,
  eventAt:null,knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:checked,source:'synthetic',evidenceRef:'synthetic:hero',reviewState:'accepted' as const,...overrides};}
function input(){const q=scenarioInput();q.scheduledAt=q.cutoffAt;q.context.leagueId='1';q.draft={assignments:[{teamSlot:'B',rolePos:3,heroId:1}],bans:[]};return q;}
test('source-backed allowance/denial includes three clocks and keeps A/B role mapping',()=>{
  const r=registry();r.heroRules=[rule()];let a=assessScenarioDraft(input(),r,checked);expect(a.status).toBe('available');expect(a.heroes[0]).toMatchObject({teamSlot:'B',rolePos:3,decision:{value:true,evidenceIds:['2']}});
  expect(a.proofs.find(p=>p.kind==='hero')).toMatchObject({knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:checked,eventAt:null});
  r.heroRules=[rule({allowed:false})];a=assessScenarioDraft(input(),r,checked);expect(a.status).toBe('blocked');expect(a.teamAWinProbability).toBeNull();
});
test('missing patch/league/scheduled start and registry coverage stay unknown, never implicit allowance',()=>{
  const r=registry();r.heroRules=[rule()];
  for(const q of [{...input(),scheduledAt:null},{...input(),context:{...input().context,leagueId:null}},{...input(),scheduledAt:'2025-01-01T00:00:00.000Z'}]){
    const a=assessScenarioDraft(q,r,checked);expect(a.status).toBe('unknown');expect(a.heroes[0]?.decision.value).toBeNull();
  }
});
test('later-known/event rules and unverified/rejected evidence cannot affect historical decisions',()=>{
  for(const override of [{knownAt:checked},{eventAt:checked},{reviewState:'unverified' as const},{reviewState:'rejected' as const}]){
    const r=registry();r.heroRules=[rule({allowed:false,...override})];expect(assessScenarioDraft(input(),r,checked).heroes[0]?.decision.value).toBeNull();
  }
});
test('contradicting accepted claims and explicit conflict stay unknown with both source references',()=>{
  const r=registry();r.heroRules=[rule(),{...rule({allowed:false}),id:'3'}];const a=assessScenarioDraft(input(),r,checked);
  expect(a.status).toBe('unknown');expect(a.heroes[0]?.decision).toMatchObject({value:null,reason:'CONFLICT',evidenceIds:['2','3']});expect(a.proofs.filter(p=>p.kind==='hero')).toHaveLength(2);
});
test('validity end is exclusive; bans get availability decisions without fabricated sequence',()=>{
  const q=input(),r=registry();q.draft={assignments:[],bans:[{teamSlot:'A',heroId:1}]};r.heroRules=[rule({validTo:q.scheduledAt})];
  const a=assessScenarioDraft(q,r,checked);expect(a.heroes[0]).toMatchObject({action:'ban',rolePos:null,decision:{value:null}});expect(a.draftOrderValidated).toBe(false);
});
test('future cutoff cannot see future knowledge; complete ten stays prediction unavailable',()=>{
  const q=input(),r=registry();q.cutoffAt='2027-01-01T00:00:00.000Z';q.scheduledAt=q.cutoffAt;r.heroRules=[rule({knownAt:'2026-11-01T00:00:00.000Z',fetchedAt:'2027-01-01T00:00:00.000Z',allowed:false})];
  expect(assessScenarioDraft(q,r,checked).knowledgeAt).toBe(checked);
  q.draft!.assignments=Array.from({length:10},(_,i)=>({teamSlot:i<5?'A':'B',rolePos:i%5+1,heroId:i+1}));const a=assessScenarioDraft(q,r,checked);
  expect(a.fullDraft).toBe(true);expect(a.predictionStatus).toBe('unavailable');expect(a.teamAWinProbability).toBeNull();
});
