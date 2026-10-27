import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { predictLogistic, type LogisticArtifact } from '../src/model-inference.js';

describe('Python ↔ TypeScript model parity fixture', () => {
  const artifact = JSON.parse(readFileSync(new URL('../../../tests/golden/synthetic-logistic-candidate.json', import.meta.url), 'utf8'));
  it('marks synthetic artifact not deployable', () => {
    expect(artifact.synthetic_only).toBe(true);
    expect(artifact.deployable).toBe(false);
  });
  it('matches independently trained Python golden probabilities', () => {
    for (const row of artifact.reference_predictions) {
      expect(predictLogistic(artifact as LogisticArtifact, row.features)).toBeCloseTo(row.probability, 10);
    }
  });
  it('rejects missing features', () => {
    expect(() => predictLogistic(artifact as LogisticArtifact, {})).toThrow('Missing feature');
  });
});
