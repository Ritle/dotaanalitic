export const FORECAST_METRIC_POLICY = 'forecast-binary-v1';
export const FORECAST_LOG_LOSS_CLIP = 1e-15;
/** Team-A oriented probabilities; callers select one primary observation per map first. */
export function forecastMetrics(rows: readonly { probability: number; teamAWon: boolean }[]) {
  let correct=0,accuracyN=0,ties=0,brier=0,logLoss=0;
  const bins=Array.from({length:10},(_,i)=>({lower:i/10,upper:(i+1)/10,upperInclusive:i===9,n:0,p:0,wins:0}));
  for(const row of rows) {
    const p=row.probability;
    if(!Number.isFinite(p)||p<0||p>1||typeof row.teamAWon!=='boolean') throw Error('invalid_forecast_metric_observation');
    const y=Number(row.teamAWon);
    if(p===0.5) ties++; else {accuracyN++;if((p>0.5)===row.teamAWon)correct++;}
    brier+=(p-y)**2;
    const clipped=Math.min(1-FORECAST_LOG_LOSS_CLIP,Math.max(FORECAST_LOG_LOSS_CLIP,p));
    logLoss-=y*Math.log(clipped)+(1-y)*Math.log1p(-clipped);
    const bin=bins.find(b=>p<b.upper||b.upperInclusive)!;bin.n++;bin.p+=p;bin.wins+=y;
  }
  return {n:rows.length,accuracyN,correct,ties,accuracy:accuracyN?correct/accuracyN:null,
    brier:rows.length?brier/rows.length:null,logLoss:rows.length?logLoss/rows.length:null,
    reliability:bins.map(({p,wins,...bin})=>({...bin,meanProbability:bin.n?p/bin.n:null,observedWinRate:bin.n?wins/bin.n:null}))};
}
