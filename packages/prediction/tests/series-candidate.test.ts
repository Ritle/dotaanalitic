import {test,expect} from 'vitest';
import {seriesCandidateProbability,evaluateSeriesDiagnostic,SERIES_CANDIDATE_POLICY} from '../src/series/candidate';
const row={seriesKey:'pandascore:1',forecastId:'first',bestOf:3,startedAt:'2026-01-02T10:00:00Z',endedAt:'2026-01-02T13:00:00Z',
 baseIssuedAt:'2026-01-02T09:00:00Z',featureCutoffAt:'2026-01-02T08:00:00Z',mapProbability:.6,teamAWon:true,sourceSha256:'a'.repeat(64)};
test('BO1/3/5 arithmetic and symmetry, no implicit BO2 or invalid probability',()=>{
 expect(seriesCandidateProbability(.6,1)).toBe(.6);expect(seriesCandidateProbability(.6,3)).toBeCloseTo(.648,14);expect(seriesCandidateProbability(.6,5)).toBeCloseTo(.68256,14);
 for(const bestOf of [1,3,5] as const)for(const p of [0,.01,.2,.5,.7,.99,1])expect(seriesCandidateProbability(p,bestOf)+seriesCandidateProbability(1-p,bestOf)).toBeCloseTo(1,14);
 for(const p of [NaN,Infinity,-.1,1.1])expect(()=>seriesCandidateProbability(p,3)).toThrow();
 expect(()=>seriesCandidateProbability(.6,2 as 3)).toThrow();expect(SERIES_CANDIDATE_POLICY.deployable).toBe(false);
});
test('whole series counts once; latest pre-start recalculation chosen deterministically',()=>{
 const r=evaluateSeriesDiagnostic([row,{...row,forecastId:'later',baseIssuedAt:'2026-01-02T09:30:00Z'}]);
 expect(r.seriesCandidate.n).toBe(1);expect(r.selectedForecastIds).toEqual(['later']);expect(r.seriesCandidate.brier).toBeCloseTo((1-.648)**2);
 expect(r.independentValidation).toBe(false);expect(r.qualityGate).toBe('not_evaluated');expect(r.deployable).toBe(false);
 expect(()=>evaluateSeriesDiagnostic([row,row])).toThrow('duplicate_forecast_id');
});
test('map-two probabilities and late feature cutoffs never enter pre-series diagnostics',()=>{
 for(const patch of [{baseIssuedAt:row.startedAt},{featureCutoffAt:row.startedAt},{endedAt:row.startedAt}]){
  const r=evaluateSeriesDiagnostic([{...row,...patch}]);expect(r.seriesCandidate).toEqual({n:0,brier:null,logLoss:null});expect(r.excluded[0]?.reason).toBe('NO_PRE_SERIES_INPUT');
 }
});
test('conflicting series labels remove whole series, empty input produces null metrics',()=>{
 const r=evaluateSeriesDiagnostic([row,{...row,forecastId:'conflict',teamAWon:false}]);expect(r.seriesCandidate.n).toBe(0);expect(r.excluded[0]?.reason).toBe('SERIES_EVIDENCE_CONFLICT');
 expect(evaluateSeriesDiagnostic([]).constantBaseline).toEqual({n:0,brier:null,logLoss:null});
});
