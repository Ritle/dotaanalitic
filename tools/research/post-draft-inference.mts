/** Pure research inference; intentionally not exported by the production prediction package. */
export type Inputs = {eloLogit: number; signedHeroes: {heroId: number; value: number}[]};
export type FittedModel = {status: 'fitted'; featureOrder: string[]; coefficients: number[]; intercept: 0;
  calibration: {status: 'fitted' | 'insufficient'; temperature: number | null}};
export function sigmoid(x: number): number {
  if (!Number.isFinite(x)) throw Error('nonfinite_logit');
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x); return e / (1 + e);
}
export function encode(inputs: Inputs, vocabulary: number[]): number[] {
  if (!Number.isFinite(inputs.eloLogit) || vocabulary.some((h, i) => !Number.isSafeInteger(h) || h <= 0 || (i > 0 && h <= vocabulary[i - 1]!))) throw Error('invalid_feature_input');
  const heroes = inputs.signedHeroes;
  if (heroes.length !== 10 || new Set(heroes.map(h => h.heroId)).size !== 10 || heroes.reduce((n, h) => n + h.value, 0) !== 0 ||
    heroes.some(h => !Number.isSafeInteger(h.heroId) || !vocabulary.includes(h.heroId) || ![-1, 1].includes(h.value))) throw Error('invalid_heroes');
  const byId = new Map(heroes.map(h => [h.heroId, h.value]));
  return [inputs.eloLogit, ...vocabulary.map(id => byId.get(id) ?? 0)];
}
export function infer(model: FittedModel, name: 'M1' | 'M2', inputs: Inputs, vocabulary: number[]) {
  const encoded = encode(inputs, vocabulary), features = name === 'M1' ? encoded.slice(0, 1) : encoded;
  const order = ['eloLogit', ...(name === 'M1' ? [] : vocabulary.map(h => 'hero:' + h))];
  if (model.status !== 'fitted' || model.intercept !== 0 || JSON.stringify(model.featureOrder) !== JSON.stringify(order) ||
    model.coefficients.length !== features.length || model.coefficients.some(c => !Number.isFinite(c))) throw Error('invalid_artifact');
  const logit = features.reduce((sum, x, i) => sum + x * model.coefficients[i]!, 0);
  let calibratedProbability: number | null = null;
  if (model.calibration.status === 'fitted') {
    const t = model.calibration.temperature;
    if (t === null || !Number.isFinite(t) || t <= 0.25 || t >= 4) throw Error('invalid_temperature');
    calibratedProbability = sigmoid(logit / t);
  } else if (model.calibration.status !== 'insufficient') throw Error('invalid_calibration_status');
  return {rawProbability: sigmoid(logit), calibratedProbability};
}
