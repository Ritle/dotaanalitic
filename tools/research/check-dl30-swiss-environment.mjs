// Run from the project root. Only frozen golden inputs are passed to the evaluator.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rmdir, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkEvaluatorEnvironment} from './prepare-dl30-registration.mjs';
import {checkPlayerHeroParity} from './player-hero-fit.mjs';

const [python, ...extra] = process.argv.slice(2);
assert(python && extra.length === 0, 'usage: node tools/research/check-dl30-swiss-environment.mjs PATH_TO_PYTHON');
const reference = JSON.parse(await readFile('docs/evidence/s3-04-dl30-registration-inputs.json', 'utf8')).inputPackage;
const threads = {OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', PYTHONHASHSEED: '42'};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function evaluate(...args) {
  const bytes = execFileSync(resolve(python), ['tools/research/conditional_future_evaluate.py', ...args], {
    env: {...process.env, ...threads}, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(bytes);
}

const environment = {node: process.version, pythonEnvironment: evaluate('environment'), threads};
checkEvaluatorEnvironment(environment, await readFile('tools/ml/requirements-ci.txt', 'utf8'));
assert.equal(environment.pythonEnvironment.python, reference.python, 'Python patch version mismatch');
assert.equal(environment.node, reference.node, 'Node version mismatch');
const artifactBytes = await readFile('.tools/s304-hero-fit-r1/artifact.json');
assert.equal(sha(artifactBytes), reference.candidateSha256, 'candidate digest mismatch');
const artifact = JSON.parse(artifactBytes);
const runtimePath = '.tools/s304-conditional-score-runtime/player-hero-inference.mjs';
const runtimeSha = sha(await readFile(runtimePath));
assert.equal(runtimeSha, '050f1c04a260d2932cbffbe562620924d70e755fe18f3ff3b990d64f67767522', 'runtime digest mismatch');
const ts = checkPlayerHeroParity(artifact, await import(pathToFileURL(resolve(runtimePath)).href));
const directory = await mkdtemp(join(tmpdir(), 'dl30-golden-'));
const inputPath = join(directory, 'inputs.json');
let comparisons = 0;
let maxAbsoluteError = 0;
try {
  for (const unavailable of [false, true]) {
    const cases = artifact.goldens.filter(g => (g.case === 'calibrator_unavailable') === unavailable);
    const models = structuredClone(artifact.models);
    if (unavailable) {
      for (const name of ['H1', 'H2']) models[name].calibration = {status: 'insufficient', temperature: null};
    }
    await writeFile(inputPath, JSON.stringify({artifact: {models}, vectors: cases.map(g => g.inputs)}));
    const predictions = evaluate('infer', inputPath);
    assert.equal(predictions.length, cases.length);
    for (const [index, golden] of cases.entries()) {
      for (const [name, expected] of Object.entries(golden.expected)) {
        for (const [field, suffix] of [['rawProbability', 'raw'], ['calibratedProbability', 'cal']]) {
          const result = predictions[index][name === 'H0' ? 'H0' : name + '_' + suffix];
          if (expected[field] === null) {
            assert.equal(result, null, 'unavailable calibration returned a probability');
          } else {
            const error = Math.abs(result.probability - expected[field]);
            assert(Number.isFinite(result.probability) && error <= ts.tolerance, 'Python golden probability mismatch');
            maxAbsoluteError = Math.max(maxAbsoluteError, error);
            comparisons++;
          }
        }
      }
    }
  }
} finally {
  await unlink(inputPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(directory);
}
assert.equal(artifact.goldens.length, reference.currentPythonGoldenParity.vectors);
assert.equal(comparisons, reference.currentPythonGoldenParity.nonNullProbabilityComparisons);
assert.equal(ts.comparisons, comparisons);
const environmentSha256 = sha(JSON.stringify(environment));
console.log(JSON.stringify({
  candidateSha256: sha(artifactBytes), runtimeSha256: runtimeSha, environment, environmentSha256,
  referenceEnvironmentSha256: reference.environmentSha256, exactEnvironmentMatch: environmentSha256 === reference.environmentSha256,
  pythonParity: {vectors: artifact.goldens.length, comparisons, maxAbsoluteError}, typescriptParity: ts,
  registrationPerformed: false, evaluationPerformedOnTargetMaps: false,
}, null, 2));
