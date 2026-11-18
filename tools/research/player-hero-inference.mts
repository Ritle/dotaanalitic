/** Pure research inference; no production export or registry access. */
export type Inputs = {eloLogit: number; observedHeroPracticeLog90Delta: number};
export type Model = {status: 'fitted'; featureOrder: string[]; coefficients: number[]; intercept: 0;
  calibration: {status: 'fitted' | 'insufficient'; temperature: number | null}};
const order = ['eloLogit', 'observedHeroPracticeLog90Delta'];
export function encode(inputs: Inputs): number[] {
  if (inputs === null || typeof inputs !== 'object' || Object.keys(inputs).sort().join() !== [...order].sort().join() ||
    !Number.isFinite(inputs.eloLogit) || !Number.isFinite(inputs.observedHeroPracticeLog90Delta)) throw Error('invalid_features');
  return [inputs.eloLogit, inputs.observedHeroPracticeLog90Delta];
}
export function sigmoid(value: number): number {
  if (!Number.isFinite(value)) throw Error('nonfinite_logit');
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const e = Math.exp(value); return e / (1 + e);
}
export function infer(model: Model, name: 'H1' | 'H2', inputs: Inputs) {
  if (name !== 'H1' && name !== 'H2') throw Error('invalid_model');
  const values = encode(inputs).slice(0, name === 'H1' ? 1 : 2);
  if (model.status !== 'fitted' || model.intercept !== 0 || JSON.stringify(model.featureOrder) !== JSON.stringify(order.slice(0, values.length)) ||
    model.coefficients.length !== values.length || model.coefficients.some(c => !Number.isFinite(c))) throw Error('invalid_artifact');
  const logit = values.reduce((sum, x, i) => sum + x * model.coefficients[i]!, 0);
  let calibratedProbability: number | null = null;
  if (model.calibration.status === 'fitted') {
    const t = model.calibration.temperature;
    if (t === null || !Number.isFinite(t) || t <= .25 + 1e-6 || t >= 4 - 1e-6) throw Error('invalid_temperature');
    calibratedProbability = sigmoid(logit / t);
  } else if (model.calibration.status !== 'insufficient') throw Error('invalid_calibration_status');
  return {rawProbability: sigmoid(logit), calibratedProbability};
}
