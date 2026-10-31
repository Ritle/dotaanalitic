import {expect,it} from 'vitest';
import {evaluatePatchWeightPolicies,type PatchWeightEvaluationInput} from '../src/patch-weight-evaluation.js';
import {patchRegistry,policy} from './patch-fixtures.js';
function input():PatchWeightEvaluationInput{return {datasetSha256:'a'.repeat(64),codeRevision:'synthetic-code',cohortKey:'synthetic:hero-1-role-1',origin:'synthetic',
  policyFrozenAt:'2023-12-31T00:00:00.000Z',policy,feature:'draft_hero',heroIds:[1],leagueId:'100',
  maps:(['train','calibration','validation','test'] as const).map((split,i)=>({matchId:String(i+1),seriesId:`00000000-0000-4000-8000-00000000000${i+1}`,
    startedAt:`2024-01-0${i+2}T00:00:00.000Z`,endedAt:`2024-01-0${i+2}T01:00:00.000Z`,labelKnownAt:`2024-01-0${i+2}T02:00:00.000Z`,
    won:i%2===0,isPro:true,outcomeEvidenceRef:'synthetic:verified-outcome',split}))};}
it('compares three fixed policies on identical temporal held-out maps with Brier/log loss/ECE',()=>{
  const q=input(),r=evaluatePatchWeightPolicies(q,patchRegistry());
  expect(r.status).toBe('evaluated_candidate');expect(r.scoredMapIds).toEqual(['3','4']);expect(r.coverage.scoredMaps).toBe(2);
  expect(r.validation.unweighted).toMatchObject({n:1,brier:0.25});expect(r.test.unweighted).toMatchObject({n:1,brier:4/9});
  for(const s of [r.test,r.validation])for(const m of Object.values(s)){expect(m.logLoss).not.toBeNull();expect(m.ece).not.toBeNull();}
  expect(r).toMatchObject({deployable:false,origin:'synthetic',modelQualityGate:'not_assessed'});
});
it('target label changes only scoring, never the current map historical estimate',()=>{
  const q=input(),before=evaluatePatchWeightPolicies(q,patchRegistry());q.maps[2]!.won=false;
  const after=evaluatePatchWeightPolicies(q,patchRegistry());expect(before.validation.unweighted.brier).toBe(after.validation.unweighted.brier);
  for(const key of ['time_only','time_patch_hero'] as const)
    expect(Math.sqrt(before.validation[key].brier!)+Math.sqrt(after.validation[key].brier!)).toBeCloseTo(1);
});
it('duplicate maps, overlapping chronology, split series and late policy selection are rejected',()=>{
  const q=input();q.maps[1]!.matchId='1';expect(()=>evaluatePatchWeightPolicies(q,patchRegistry())).toThrow('invalid_evaluation_maps');
  const s=input();s.maps[2]!.seriesId=s.maps[0]!.seriesId;expect(()=>evaluatePatchWeightPolicies(s,patchRegistry())).toThrow('series_crosses');
  const overlap=input();overlap.maps[0]!.labelKnownAt=overlap.maps[2]!.startedAt;expect(()=>evaluatePatchWeightPolicies(overlap,patchRegistry())).toThrow('overlapping');
  const late=input();late.policyFrozenAt=late.maps[2]!.startedAt;expect(()=>evaluatePatchWeightPolicies(late,patchRegistry())).toThrow('policy_not_frozen');
});
it('missing metadata withholds the whole common cohort rather than improving scores through selective exclusion',()=>{
  const reg=patchRegistry();reg.heroRules=[];const r=evaluatePatchWeightPolicies(input(),reg);
  expect(r.status).toBe('unavailable');expect(r.scoredMapIds).toEqual([]);expect(r.test.unweighted).toEqual({n:0,brier:null,logLoss:null,ece:null});
  expect(r.excluded).toHaveLength(2);
});
it('future labels and same-series earlier maps never enter historical counts',()=>{
  const q=input();q.maps.push({...q.maps[2]!,matchId:'9',startedAt:'2024-01-04T12:00:00.000Z',endedAt:'2024-01-04T13:00:00.000Z',labelKnownAt:'2024-01-04T14:00:00.000Z'});
  const r=evaluatePatchWeightPolicies(q,patchRegistry());expect(r.validation.unweighted.n).toBe(2);expect(r.validation.unweighted.brier).toBe(0.25);
});
