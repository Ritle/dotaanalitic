/** Product sample-size labels, never confidence or model probabilities. */
export function sampleEvidence(nRaw:number|null){
  if(nRaw!==null&&(!Number.isSafeInteger(nRaw)||nRaw<0))throw new Error('invalid_sample_size');
  const band=nRaw===null?'unknown':nRaw===0?'empty':nRaw<10?'under_10':nRaw<30?'10_to_29':'30_or_more';
  return {policyVersion:'sample-evidence-v1' as const,nRaw,nEff:null,weightPolicyVersion:null,band,
    coldStart:nRaw===null?null:nRaw===0,smallSample:nRaw===null?null:nRaw<30};
}
/** Scale-normalized Kish and rate, using only explicitly supplied real weights. */
export function weightedSample(rows:readonly {matchId:string;won:boolean;weight:number}[],weightPolicyVersion:string){
  if(!weightPolicyVersion.trim()||new Set(rows.map(r=>r.matchId)).size!==rows.length||rows.some(r=>!/^[1-9]\d{0,18}$/.test(r.matchId)||BigInt(r.matchId)>9223372036854775807n||typeof r.won!=='boolean'||!Number.isFinite(r.weight)||r.weight<0))
    throw new Error('invalid_weighted_sample');
  const maxWeight=rows.reduce((m,r)=>Math.max(m,r.weight),0),scaled=rows.map(r=>maxWeight?r.weight/maxWeight:0);
  const sum=scaled.reduce((a,b)=>a+b,0),squareSum=scaled.reduce((a,b)=>a+b*b,0),wins=rows.filter(r=>r.won).length;
  return {nRaw:rows.length,wins,observedRate:rows.length?wins/rows.length:null,positiveWeightMaps:rows.filter(r=>r.weight>0).length,
    weightedRate:sum?scaled.reduce((n,w,i)=>n+(rows[i]!.won?w:0),0)/sum:null,nEff:squareSum?Math.min(rows.length,sum*sum/squareSum):null,weightPolicyVersion};
}
/** Empirical reference-count Beta prior. No pseudo-count constants or target-window tuning. */
export function shrinkObservedRate(nRaw:number,wins:number,referenceN:number,referenceWins:number){
  if([nRaw,wins,referenceN,referenceWins,nRaw+referenceN].some(n=>!Number.isSafeInteger(n)||n<0)||wins>nRaw||referenceWins<=0||referenceWins>=referenceN)
    throw new Error('invalid_reference_prior');
  return {observedRate:nRaw?wins/nRaw:null,smoothedObservedRate:(wins+referenceWins)/(nRaw+referenceN),priorOnly:nRaw===0,
    prior:{alpha:referenceWins,beta:referenceN-referenceWins,mean:referenceWins/referenceN,mass:referenceN},validation:'unvalidated_descriptive' as const};
}
