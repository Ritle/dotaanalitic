// Reproducible inputs for owner review before registration. No database or provider access.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectionV2RemoteManifestPaths} from './conditional-collection-v2-remote.mjs';
import {ExclusionIdsSchema, inspectRealRegistrationEnvironment, realCandidateSha, realExposureIdsSha,
  realExposureSha, realPolicySha, realSha} from './conditional-real-registration.mjs';
import {checkPlayerHeroParity} from './player-hero-fit.mjs';

const proposalPath = 'tools/research/player-hero-dl30-window-proposal.json';
const proposalSha = '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045';
const refreshPath = 'docs/evidence/s3-04-dl30-exposure-refresh-r2.json';
const refreshSha = '0589842c1c04e69afa54f287611aa6bcd1d5229bec0891cfb22b8919dc0e10ed';
const output = '.tools/s304-dl30-registration-inputs-r1.json';
const runtimePath = '.tools/s304-conditional-score-runtime/player-hero-inference.mjs';
const requirementsPath = 'tools/ml/requirements-ci.txt';

async function pinnedJson(path, expected) {
  const bytes = await readFile(path);
  assert.equal(realSha(bytes), expected, 'input hash mismatch: ' + path);
  return JSON.parse(bytes);
}

export function checkExclusions(ledger, additions, snapshot) {
  const base = ExclusionIdsSchema.parse({mapIds: ledger.mapIds, canonicalSeriesKeys: ledger.canonicalSeriesKeys});
  assert.equal(realSha(JSON.stringify(base)), realExposureIdsSha, 'original exclusions changed');
  const ids = ExclusionIdsSchema.parse(snapshot);
  for (const key of Object.keys(base)) {
    const expected = [...base[key], ...additions[key]].sort();
    assert.equal(new Set(expected).size, expected.length, 'duplicate exclusion');
    assert.deepEqual(ids[key], expected, 'exclusion refresh mismatch');
  }
}

export function checkEvaluatorEnvironment(environment, requirements) {
  const python = environment.pythonEnvironment;
  assert.match(python.python, /^3\.13\./u, 'Python 3.13 required by the project ML environment');
  const installed = new Map(python.packages.map(p => [p.name.toLowerCase(), p.version]));
  for (const line of requirements.split(/\r?\n/u).map(s => s.trim())) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([\w.-]+)==([\w.-]+)$/u.exec(line);
    assert(match, 'unsupported requirement: ' + line);
    assert.equal(installed.get(match[1].toLowerCase()), match[2], 'dependency mismatch: ' + match[1]);
  }
}

async function prepare() {
  const proposal = await pinnedJson(proposalPath, proposalSha);
  assert.equal(proposal.parent.sha256, realPolicySha);
  const parent = await pinnedJson(proposal.parent.path, realPolicySha);
  const candidate = await pinnedJson(parent.candidate.artifactPath, realCandidateSha);
  const refresh = await pinnedJson(refreshPath, refreshSha);
  const archive = await pinnedJson(parent.independence.exposure.path, realExposureSha);
  const ids = await pinnedJson(refresh.snapshot.path, refresh.snapshot.sha256);
  checkExclusions(archive.result.ledger, refresh.added, ids);
  const environment = JSON.parse(await inspectRealRegistrationEnvironment());
  checkEvaluatorEnvironment(environment, await readFile(requirementsPath, 'utf8'));
  const runtime = await import(pathToFileURL(resolve(runtimePath)).href);
  const parity = checkPlayerHeroParity(candidate, runtime);
  const paths = new Set([...await collectionV2RemoteManifestPaths(), requirementsPath, proposalPath, proposal.parent.path,
    'tools/research/prepare-dl30-registration.mjs', 'tools/research/player-hero-experiment-policy.json',
    'tools/research/post-draft-policy.json']);
  const code = {};
  for (const path of [...paths].sort()) code[path] = realSha(await readFile(path));
  return {
    format: 'dl30-registration-inputs-v1', status: 'prepared_for_review', proposalSha256: proposalSha,
    parentPolicySha256: realPolicySha, scope: proposal.scope,
    inheritedPolicy: Object.fromEntries(proposal.parent.inheritExactly.map(k => [k, parent[k]])),
    candidateSha256: realCandidateSha, exclusionFloor: refresh.snapshot,
    executable: {code, environment, parity}, registeredAt: null,
    registrationReady: false, collectionAllowed: false, evaluationAllowed: false, activationAllowed: false
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...extra] = process.argv.slice(2);
  assert(['prepare', 'verify'].includes(mode) && !extra.length, 'usage: prepare-dl30-registration.mjs prepare|verify');
  const result = await prepare();
  const bytes = JSON.stringify(result, null, 2) + '\n';
  if (mode === 'prepare') await writeFile(output, bytes, {flag: 'wx'});
  assert.equal(realSha(await readFile(output)), realSha(bytes), 'prepared package changed');
  console.log(JSON.stringify({mode, path: output, sha256: realSha(bytes),
    files: Object.keys(result.executable.code).length, python: result.executable.environment.pythonEnvironment.python,
    node: result.executable.environment.node, parity: result.executable.parity, registeredAt: result.registeredAt}));
}
