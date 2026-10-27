/** Dependency-free JS parity runner. Uses the same scoring formula as TS source. */
import fs from 'node:fs';
const filename=process.argv[2];
if(!filename){console.error('Usage: node scripts/check-ml-parity.mjs PATH_TO_MODEL_JSON');process.exit(2)}
const m=JSON.parse(fs.readFileSync(filename,'utf8'));
if(m.format!=='dota2-logistic-v1'||m.deployable!==false)throw Error('Unknown/non-candidate model');
function predict(features){
 let z=m.intercept;
 for(let i=0;i<m.feature_names.length;i++){
  const key=m.feature_names[i]; const value=features[key]??m.imputer_medians[i];
  z+=m.coefficients[i]*((value-m.scaler_mean[i])/m.scaler_scale[i]);
 }
 const a=m.calibration_intercept+m.calibration_slope*z;
 return a>=0?1/(1+Math.exp(-a)):Math.exp(a)/(1+Math.exp(a));
}
for(const row of m.reference_predictions){
 const value=predict(row.features);
 if(Math.abs(value-row.probability)>1e-10)throw new Error(`Python/JS parity failed for ${row.match_id}: ${value} != ${row.probability}`);
}
console.log(`Python ↔ JS logistic parity PASS: ${m.reference_predictions.length} reference predictions`);
