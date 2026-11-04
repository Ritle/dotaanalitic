import {expect,it} from 'vitest';
import {forecastMetrics} from '../src/forecast-metrics.js';
it('leaves empty rates and empty reliability bins null',()=>{
  const result=forecastMetrics([]);expect(result).toMatchObject({n:0,accuracyN:0,accuracy:null,brier:null,logLoss:null});
  expect(result.reliability.every(b=>b.n===0&&b.meanProbability===null&&b.observedWinRate===null)).toBe(true);
});
it('keeps exact ties in probability metrics but out of accuracy',()=>{
  const r=forecastMetrics([{probability:0.5,teamAWon:true},{probability:0.5,teamAWon:false}]);
  expect(r).toMatchObject({n:2,accuracyN:0,ties:2,accuracy:null,brier:0.25});expect(r.logLoss).toBeCloseTo(Math.log(2),14);
});
it('uses unrounded probabilities for favourites and standard Brier and natural log loss',()=>{
  const r=forecastMetrics([{probability:0.5000000001,teamAWon:true},{probability:0.4999999999,teamAWon:false},
    {probability:0.8,teamAWon:false},{probability:0.2,teamAWon:true}]);
  expect(r).toMatchObject({n:4,accuracyN:4,correct:2,ties:0,accuracy:0.5});
  expect(r.brier).toBeCloseTo((2*0.4999999999**2+2*0.8**2)/4,14);
  expect(r.logLoss).toBeCloseTo((-2*Math.log(0.5000000001)-2*Math.log(0.2))/4,14);
});
it('assigns exact bin boundaries once including p=0 and p=1',()=>{
  const r=forecastMetrics(Array.from({length:11},(_,i)=>({probability:i/10,teamAWon:i%2===0})));
  expect(r.reliability.map(b=>b.n)).toEqual([1,1,1,1,1,1,1,1,1,2]);
  expect(r.reliability[9]).toMatchObject({upperInclusive:true,meanProbability:0.95,observedWinRate:0.5});
  expect(Number.isFinite(r.logLoss)).toBe(true);
});
it('complements A/B without changing accuracy, Brier or log loss',()=>{
  const rows=[{probability:0.1,teamAWon:true},{probability:0.8,teamAWon:true},{probability:0.5,teamAWon:false}];
  const a=forecastMetrics(rows),b=forecastMetrics(rows.map(r=>({probability:1-r.probability,teamAWon:!r.teamAWon})));
  expect(a.accuracy).toBe(b.accuracy);expect(a.brier).toBeCloseTo(b.brier!,14);expect(a.logLoss).toBeCloseTo(b.logLoss!,14);
});
it('rejects non-probabilities rather than silently clipping invalid inputs',()=>{
  for(const probability of [NaN,Infinity,-0.1,1.1])expect(()=>forecastMetrics([{probability,teamAWon:true}])).toThrow();
});
