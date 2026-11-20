import assert from 'node:assert/strict';
import test from 'node:test';
import {checkEvaluatorEnvironment, checkExclusions} from '../../tools/research/prepare-dl30-registration.mjs';

const environment = {pythonEnvironment: {python: '3.13.18', packages: [{name: 'Pygments', version: '2.20.0'}]}};

test('checks every pinned dependency, including Windows line endings and distribution name casing', () => {
  checkEvaluatorEnvironment(environment, '# fixture\r\npygments==2.20.0\r\n');
  assert.throws(() => checkEvaluatorEnvironment(environment, 'pygments==2.19.0'), /dependency mismatch/u);
  assert.throws(() => checkEvaluatorEnvironment(environment, 'scipy==1.17.0'), /dependency mismatch/u);
  assert.throws(() => checkEvaluatorEnvironment(environment, 'pygments>=2'), /unsupported requirement/u);
  assert.throws(() => checkEvaluatorEnvironment({pythonEnvironment: {...environment.pythonEnvironment, python: '3.10.5'}}, ''), /Python 3.13/u);
});

test('a self-consistent shortened registry cannot replace the pinned original', () => {
  const shortened = {mapIds: ['7'], canonicalSeriesKeys: ['["opendota","9"]']};
  assert.throws(() => checkExclusions(shortened, {mapIds: [], canonicalSeriesKeys: []}, shortened), /original exclusions changed/u);
});
