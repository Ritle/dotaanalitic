/** Versioned, deterministic scorer for a validated offline logistic candidate.
 * Do not call until an external trusted activation gate approves the model.
 */
export interface LogisticArtifact {
  format: 'dota2-logistic-v1';
  feature_names: string[];
  imputer_medians: number[];
  scaler_mean: number[];
  scaler_scale: number[];
  intercept: number;
  coefficients: number[];
  calibration_intercept: number;
  calibration_slope: number;
  synthetic_only: boolean;
  deployable: boolean;
}
export function predictLogistic(artifact: LogisticArtifact, features: Record<string, number | null>): number {
  if (artifact.format !== 'dota2-logistic-v1') throw new Error('Unsupported artifact schema');
  const n = artifact.feature_names.length;
  if (n === 0 || [artifact.imputer_medians, artifact.scaler_mean, artifact.scaler_scale, artifact.coefficients].some(a => a.length !== n)) {
    throw new Error('Invalid logistic artifact dimensions');
  }
  let z = artifact.intercept;
  for(let i=0;i<n;i++){
    const key=artifact.feature_names[i]!;
    if(!Object.prototype.hasOwnProperty.call(features,key)) throw new Error(`Missing feature ${key}`);
    const v=features[key] ?? artifact.imputer_medians[i]!;
    const denominator=artifact.scaler_scale[i]!;
    if(!Number.isFinite(v)||!Number.isFinite(denominator)||denominator<=0) throw new Error('Nonfinite feature/scale');
    z += artifact.coefficients[i]!*((v-artifact.scaler_mean[i]!)/denominator);
  }
  const logit=artifact.calibration_intercept + artifact.calibration_slope*z;
  if(!Number.isFinite(logit)) throw new Error('Invalid inference output');
  if(logit>=0) return 1/(1+Math.exp(-logit));
  const exp=Math.exp(logit); return exp/(1+exp);
}
