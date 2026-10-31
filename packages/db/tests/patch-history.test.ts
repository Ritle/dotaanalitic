import {expect,it} from 'vitest';
import {resolveHistoryWeights} from '../src/patch-history.js';
import {patchRegistry,weightRequest,cutoff,release} from './patch-fixtures.js';
it('source-backed rework zeros old hero history while strength keeps a separate slower policy',()=>{
  const q=weightRequest(),r=resolveHistoryWeights(q,patchRegistry());
  expect(r.status).toBe('computed_candidate');expect(r.maps[0]).toMatchObject({patchId:'1',weight:0,heroWeight:0});
  expect(r.maps[1]?.weight).toBeGreaterThan(0.9);expect(r.summary).toMatchObject({nRaw:2,nEff:1});
  expect(r.patchDistribution).toEqual([{patchId:'1',nRaw:1},{patchId:'2',nRaw:1}]);
  const s=resolveHistoryWeights({...q,feature:'strength',heroIds:[]},patchRegistry());
  expect(s.maps[0]!.weight).toBeGreaterThan(0.9);expect(s.heroEligibility).toEqual([]);expect(s.teamAWinProbability).toBeNull();
});
it('release boundary uses exact verified timestamps and unknown metadata never means unchanged',()=>{
  const q=weightRequest(),reg=patchRegistry();reg.heroImpacts=[];
  expect(resolveHistoryWeights(q,reg).maps[0]).toMatchObject({weight:null,reasons:['HERO_IMPACT_UNKNOWN']});
  q.maps=[{matchId:'1',startedAt:release}];expect(resolveHistoryWeights(q,reg).maps[0]?.patchId).toBe('2');
  reg.patches=[];expect(resolveHistoryWeights(q,reg).status).toBe('unavailable');
});
it('late notes and conflicting impacts cannot rewrite an earlier as-of result',()=>{
  const reg=patchRegistry();reg.heroImpacts[0]!.knownAt='2024-01-04T00:00:00.000Z';
  expect(resolveHistoryWeights(weightRequest(),reg).maps[0]?.weight).toBeNull();
  reg.heroImpacts[0]!.knownAt=release;reg.heroImpacts.push({...reg.heroImpacts[0]!,id:'2',impactLevel:'unchanged',knownAt:'2024-01-04T00:00:00.000Z'});
  expect(resolveHistoryWeights(weightRequest(),reg).maps[0]?.weight).toBe(0);
  reg.heroImpacts[1]!.knownAt=cutoff;expect(resolveHistoryWeights(weightRequest(),reg).maps[0]?.reasons).toContain('HERO_IMPACT_CONFLICT');
});
it('missing transition, skipped release, conflicting release and coverage gap withhold transfer',()=>{
  const reg=patchRegistry();reg.transitions=[];expect(resolveHistoryWeights(weightRequest(),reg).maps[0]?.reasons).toContain('PATCH_TRANSITION_UNKNOWN');
  reg.patches[0]!.coverageUntil='2023-12-31T00:00:00.000Z';expect(resolveHistoryWeights(weightRequest(),reg).maps[0]?.reasons).toContain('PATCH_PATH_UNKNOWN');
  const other=patchRegistry();other.patches.push({...other.patches[1]!,id:'9',patchId:'3'});
  expect(resolveHistoryWeights(weightRequest(),other).targetPatch.value).toBeNull();
  const skipped=patchRegistry();skipped.patches.push({...skipped.patches[0]!,id:'10',patchId:'3',releasedAt:'2023-12-31T00:00:00.000Z'});
  expect(resolveHistoryWeights(weightRequest(),skipped).maps[0]?.reasons).toContain('PATCH_TRANSITION_CONFLICT');
});
it('availability is explicit: absent, forbidden and contradictory rules stay distinct',()=>{
  const reg=patchRegistry();reg.heroRules=[];
  expect(resolveHistoryWeights(weightRequest(),reg).maps[1]?.reasons).toContain('HERO_ELIGIBILITY_UNKNOWN');
  const deny=patchRegistry();deny.heroRules[0]!.allowed=false;
  expect(resolveHistoryWeights(weightRequest(),deny).maps[1]?.reasons).toContain('HERO_INELIGIBLE');
  deny.heroRules.push({...deny.heroRules[0]!,id:'8',allowed:true});
  expect(resolveHistoryWeights(weightRequest(),deny).maps[1]?.reasons).toContain('HERO_ELIGIBILITY_CONFLICT');
});
it('request cutoff, duplicates and feature scopes are validated without rounding',()=>{
  const q=weightRequest();expect(()=>resolveHistoryWeights({...q,maps:[{matchId:'1',startedAt:cutoff}]},patchRegistry())).toThrow();
  expect(()=>resolveHistoryWeights({...q,maps:[q.maps[0]!,q.maps[0]!]},patchRegistry())).toThrow();
  expect(()=>resolveHistoryWeights({...q,feature:'strength'},patchRegistry())).toThrow();
  expect(()=>resolveHistoryWeights({...q,cutoffAt:'2024-01-03T00:00:00.000001Z'},patchRegistry())).toThrow();
});
it('cache keys include full coefficients, cutoff, feature inputs and registry revision without mutating snapshots',()=>{
  const q=weightRequest(),reg=patchRegistry(),original=resolveHistoryWeights(q,reg);
  reg.revision='6';expect(resolveHistoryWeights(q,reg).cacheKey).not.toBe(original.cacheKey);
  expect(original.registryRevision).toBe('5');q.policy=structuredClone(q.policy);q.policy.draft.halfLifeDays=61;
  expect(resolveHistoryWeights(q,reg).cacheKey).not.toBe(resolveHistoryWeights(weightRequest(),reg).cacheKey);
});
it('new patch cold start is raw zero with separate effective history, never a forecast',()=>{
  const q=weightRequest();q.maps=q.maps.slice(0,1);const reg=patchRegistry();reg.heroImpacts[0]!.impactLevel='minor';
  const r=resolveHistoryWeights(q,reg);expect(r).toMatchObject({patchColdStart:true,targetPatchMaps:0,currentPatchShare:0,teamAWinProbability:null,deployable:false});
  expect(r.summary.nEff).toBe(1);
});
it('hero input order has identical arithmetic and cache identity',()=>{
  const q=weightRequest(),reg=patchRegistry();q.heroIds=[1,2,3];q.policy=structuredClone(q.policy);
  q.policy.draft.heroFactors={unchanged:1,minor:0.1,moderate:0.2,major:0.3,rework:0};
  const first=reg.heroImpacts[0]!,rule=reg.heroRules[0]!;
  reg.heroImpacts=[{...first,impactLevel:'minor'},{...first,id:'2',heroId:2,impactLevel:'moderate'},{...first,id:'3',heroId:3,impactLevel:'major'}];
  reg.heroRules.push({...rule,id:'5',heroId:2},{...rule,id:'6',heroId:3});
  const a=resolveHistoryWeights(q,reg),b=resolveHistoryWeights({...q,heroIds:[3,2,1]},reg);
  expect(a.cacheKey).toBe(b.cacheKey);expect(a.maps[0]?.heroWeight).toBe(b.maps[0]?.heroWeight);
});
