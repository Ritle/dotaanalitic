import {expect,it} from 'vitest';
import {forecastVerdict,type ForecastVerdictInput} from '../src/forecast-verdict';
const base:ForecastVerdictInput={status:'primary',calculationStatus:'done',probability:.7,actualWinner:'A',correct:true};
it('compares the original probability and verified A/B winner in both orientations',()=>{
 expect(forecastVerdict(base)).toMatchObject({kind:'correct',label:'Прогноз верен',tone:'success'});
 expect(forecastVerdict({...base,actualWinner:'B',correct:false})).toMatchObject({kind:'incorrect',label:'Прогноз неверен',tone:'danger'});
 expect(forecastVerdict({...base,probability:.3,actualWinner:'B'}).kind).toBe('correct');
 expect(forecastVerdict({...base,probability:.499999,actualWinner:'B'}).kind).toBe('correct');
});
it('never turns a missing result, cancellation, excluded or conditional record into a wrong prediction',()=>{
 for(const status of ['pending_verification','unlinked','cancelled','excluded','what_if','unavailable'] as const){
  const result=forecastVerdict({...base,status,calculationStatus:status==='unavailable'?'unavailable':'done'});
  expect(['correct','incorrect']).not.toContain(result.kind);
 }
 expect(forecastVerdict({...base,actualWinner:null,correct:null}).kind).toBe('pending');
 expect(forecastVerdict({...base,probability:null}).kind).toBe('unavailable');
 expect(forecastVerdict({...base,probability:.5,correct:null}).kind).toBe('tie');
});
it('separates previous recalculations and stale or inconsistent evidence from primary accuracy',()=>{
 expect(forecastVerdict({...base,status:'superseded'}).detail).toContain('не учитывается');
 expect(forecastVerdict({...base,sourceChangedSinceRefresh:true}).kind).toBe('stale');
 expect(forecastVerdict({...base,correct:false}).kind).toBe('inconsistent');
 expect(forecastVerdict({...base,correct:null}).kind).toBe('inconsistent');
 expect(forecastVerdict({...base,status:'eligible',correct:undefined}).detail).toContain('выбирается в журнале');
});
