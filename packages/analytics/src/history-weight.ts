/** Experimental arithmetic only. Eligibility and evidence are the caller's responsibility. */
export function historyWeight(ageDays:number,halfLifeDays:number,transitionPenalties:readonly number[],heroFactors:readonly number[]){
  if(!Number.isFinite(ageDays)||ageDays<0||!Number.isFinite(halfLifeDays)||halfLifeDays<=0||
    transitionPenalties.some(p=>!Number.isFinite(p)||p<0)||heroFactors.some(f=>!Number.isFinite(f)||f<0||f>1))throw new Error('invalid_history_weight');
  const timeWeight=2**(-ageDays/halfLifeDays),patchWeight=Math.exp(-transitionPenalties.reduce((a,b)=>a+b,0)),heroWeight=heroFactors.reduce((a,b)=>a*b,1);
  return {timeWeight,patchWeight,heroWeight,weight:timeWeight*patchWeight*heroWeight};
}
export function historyWeightSummary(weights:readonly (number|null)[]){
  if(weights.some(w=>w!==null&&(!Number.isFinite(w)||w<0||w>1)))throw new Error('invalid_history_weight');
  const known=weights.filter((w):w is number=>w!==null),max=known.reduce((a,b)=>Math.max(a,b),0),scaled=known.map(w=>max?w/max:0),sum=scaled.reduce((a,b)=>a+b,0),squares=scaled.reduce((a,b)=>a+b*b,0);
  return {nRaw:weights.length,weightedMaps:known.length,missingMaps:weights.length-known.length,positiveWeightMaps:known.filter(w=>w>0).length,
    nEff:squares?Math.min(known.length,sum*sum/squares):null};
}
