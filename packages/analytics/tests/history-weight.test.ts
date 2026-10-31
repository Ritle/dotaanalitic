import {expect,it} from 'vitest';
import {historyWeight,historyWeightSummary} from '../src/history-weight.js';
it('time decay discounts a three-year-old hero map more than strength without claiming accuracy',()=>{
  expect(historyWeight(60,60,[],[]).weight).toBe(0.5);
  expect(historyWeight(1095,60,[],[]).weight).toBeLessThan(0.00001);
  expect(historyWeight(1095,180,[],[]).weight).toBeGreaterThan(historyWeight(1095,60,[],[]).weight);
});
it('explicit transitions and rework multiply separately and preserve real zero',()=>{
  expect(historyWeight(0,60,[0.2,0.3],[0.5]).weight).toBeCloseTo(Math.exp(-0.5)*0.5);
  expect(historyWeight(10,60,[0.2],[0]).weight).toBe(0);
});
it('Kish distinguishes null metadata, zero weight and empty history',()=>{
  expect(historyWeightSummary([1,0.5,null,0])).toMatchObject({nRaw:4,weightedMaps:3,missingMaps:1,positiveWeightMaps:2,nEff:1.8});
  expect(historyWeightSummary([]).nEff).toBeNull();expect(historyWeightSummary([0,0]).nEff).toBeNull();
  expect(historyWeightSummary([1e-300,1e-300]).nEff).toBe(2);
});
it('invalid coefficients are rejected before arithmetic',()=>{
  for(const age of [-1,NaN,Infinity])expect(()=>historyWeight(age,60,[],[])).toThrow();
  expect(()=>historyWeight(1,0,[],[])).toThrow();expect(()=>historyWeight(1,60,[-1],[])).toThrow();
  expect(()=>historyWeight(1,60,[],[1.1])).toThrow();expect(()=>historyWeightSummary([NaN])).toThrow();
});
