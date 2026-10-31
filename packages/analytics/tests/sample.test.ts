import {expect,it} from 'vitest';
import {sampleEvidence,weightedSample,shrinkObservedRate} from '../src/sample.js';
it('unknown is distinct from zero; bands describe counts rather than confidence',()=>{
  expect(sampleEvidence(null)).toMatchObject({band:'unknown',coldStart:null,nRaw:null,nEff:null});
  expect(sampleEvidence(0)).toMatchObject({band:'empty',coldStart:true,nRaw:0,nEff:null});
  for(const [n,band] of [[1,'under_10'],[9,'under_10'],[10,'10_to_29'],[29,'10_to_29'],[30,'30_or_more']] as const)expect(sampleEvidence(n).band).toBe(band);
  expect(()=>sampleEvidence(-1)).toThrow();expect(()=>sampleEvidence(0.5)).toThrow();
});
it('Kish size reflects uneven real weights instead of replacing raw map count',()=>{
  const r=weightedSample([{matchId:'1',won:true,weight:1},{matchId:'2',won:false,weight:3}],'synthetic-weights-v1');
  expect(r).toMatchObject({nRaw:2,wins:1,observedRate:0.5,weightedRate:0.25,positiveWeightMaps:2});expect(r.nEff).toBeCloseTo(1.6);
});
it('uniform weights preserve N, zero weights do not become evidence and empty weights yield null',()=>{
  expect(weightedSample([{matchId:'1',won:true,weight:7},{matchId:'2',won:false,weight:7}],'synthetic').nEff).toBe(2);
  expect(weightedSample([{matchId:'1',won:true,weight:0}],'synthetic')).toMatchObject({nRaw:1,positiveWeightMaps:0,weightedRate:null,nEff:null});
  expect(weightedSample([],'synthetic')).toMatchObject({nRaw:0,observedRate:null,weightedRate:null,nEff:null});
});
it('Kish/rate are invariant under rescaling including very large and tiny weights',()=>{
  for(const scale of [1e-300,1,1e300]){const r=weightedSample([{matchId:'1',won:true,weight:scale},{matchId:'2',won:false,weight:scale*2}],'synthetic');
    expect(r.nEff).toBeCloseTo(1.8);expect(r.weightedRate).toBeCloseTo(1/3);}
});
it('invalid weights, duplicate maps and noncanonical IDs fail closed',()=>{
  for(const weight of [-1,NaN,Infinity])expect(()=>weightedSample([{matchId:'1',won:true,weight}],'synthetic')).toThrow();
  expect(()=>weightedSample([{matchId:'1',won:true,weight:1},{matchId:'1',won:false,weight:2}],'synthetic')).toThrow();
  expect(()=>weightedSample([{matchId:'01',won:true,weight:1}],'synthetic')).toThrow();
});
it('small samples shrink more than large ones while raw observed rates stay unchanged',()=>{
  const small=shrinkObservedRate(1,1,10,4),large=shrinkObservedRate(100,100,10,4);
  expect(small.observedRate).toBe(1);expect(large.observedRate).toBe(1);expect(small.smoothedObservedRate).toBeCloseTo(5/11);
  expect(large.smoothedObservedRate).toBeGreaterThan(small.smoothedObservedRate);expect(small.prior).toEqual({alpha:4,beta:6,mean:0.4,mass:10});
});
it('zero observations keep raw rate null; a valid prior-only estimate is explicitly identified',()=>{
  expect(shrinkObservedRate(0,0,10,4)).toMatchObject({observedRate:null,smoothedObservedRate:0.4,priorOnly:true});
});
it('degenerate priors, fractional counts and unsafe totals cannot fabricate a neutral fallback',()=>{
  for(const args of [[1,1,0,0],[1,1,10,0],[1,1,10,10],[1,2,10,4],[1.5,1,10,4],[Number.MAX_SAFE_INTEGER,1,10,4]] as const)
    expect(()=>shrinkObservedRate(args[0],args[1],args[2],args[3])).toThrow();
});
