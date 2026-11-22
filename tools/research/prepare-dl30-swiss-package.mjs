import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {link, readFile, unlink, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {collectionV2RemoteManifestPaths} from './conditional-collection-v2-remote.mjs';
import {ExclusionIdsSchema, realSha} from './conditional-real-registration.mjs';

const output = '.tools/s304-dl30-swiss-package-r1.json';
const builder = 'tools/research/prepare-dl30-swiss-package.mjs';
const checker = 'tools/research/check-dl30-swiss-environment.mjs';
const diagnostic = '.tools/blast-ix-h2-diagnostic-20261122-r3/';
const coverage = '.tools/blast-ix-h2-coverage-r1/';
const sources = {
  proposal: ['tools/research/player-hero-dl30-swiss-proposal.json', '5d6015e97563ed366f5ec40ec3c941c3896607b29c1e0b0735431bd5be2b55f0'],
  environment: ['docs/evidence/s3-04-dl30-swiss-environment.json', '4138a5b8dda665c9de2d4cee8c6e32d6a455fcfbb71f8c115ff3da8d9653f47f'],
  refresh: ['docs/evidence/s3-04-dl30-exposure-refresh-r2.json', '0589842c1c04e69afa54f287611aa6bcd1d5229bec0891cfb22b8919dc0e10ed'],
  targets: [diagnostic + 'details.json', '474c995be5dfb7e0c0d99099e13bf481878c6c7824b8b21d8bf7b119ac44afd0'],
  history: [diagnostic + 'history.json', '07e6a706bf786b15dd5adfa5cc511815b70d69c2655c2b7aec17915b07ba54a4'],
  valve: [coverage + 'valve.json', '0fae2661b942754990564813b7d94b64c8e047601110c7c585ba47bf2a9d9519'],
  discovery: [coverage + 'discovery.json', '3f213eadf25556ef9eab02987e7e15004d42e91c67718f336a00501c5afacf81'],
};

async function pinned(path, digest) {
  const bytes = await readFile(path);
  assert.equal(realSha(bytes), digest, 'source hash mismatch: ' + path);
  return JSON.parse(bytes);
}

// A Valve sibling is attributable to OpenDota only through a matching target in that series.
export function extendBlastExclusions(base, {targets, history, valve, discovery}) {
  const {mapIds, canonicalSeriesKeys} = ExclusionIdsSchema.parse(base);
  const maps = new Set(mapIds);
  const series = new Set(canonicalSeriesKeys);
  const bindings = new Map();
  function add(id, key) {
    assert(!bindings.has(id) || bindings.get(id) === key, 'conflicting map series');
    bindings.set(id, key);
    maps.add(id);
    series.add(key);
  }
  for (const row of history) add(row.matchId, row.seriesKey);
  const odKey = id => JSON.stringify(['opendota', id]);
  const targetMap = new Map();
  for (const row of targets) {
    assert(!targetMap.has(row.id), 'duplicate diagnostic map');
    targetMap.set(row.id, row.seriesId);
    add(row.id, odKey(row.seriesId));
  }
  const covered = new Set();
  for (const group of valve) {
    assert(group.maps.some(id => targetMap.get(id) === group.seriesId && targetMap.has(id)), 'unbound Valve series');
    for (const id of group.maps) {
      assert(!covered.has(id), 'duplicate Valve map');
      covered.add(id);
      add(id, odKey(group.seriesId));
    }
  }
  for (const id of targetMap.keys()) assert(covered.has(id), 'missing Valve map');
  for (const row of discovery) assert(bindings.has(row.match_id), 'unresolved discovery map');
  return ExclusionIdsSchema.parse({mapIds: [...maps].sort(), canonicalSeriesKeys: [...series].sort()});
}

async function build() {
  const inputs = {};
  for (const [name, source] of Object.entries(sources)) inputs[name] = await pinned(...source);
  const {proposal, environment, refresh} = inputs;
  const parent = await pinned(proposal.parent.path, proposal.parent.sha256);
  await pinned(proposal.alternativeTo.path, proposal.alternativeTo.sha256);
  const base = await pinned(refresh.snapshot.path, refresh.snapshot.sha256);
  const exclusions = extendBlastExclusions(base, {
    targets: inputs.targets.collected, history: inputs.history.history.maps,
    valve: inputs.valve.series, discovery: inputs.discovery.rows,
  });
  const python = process.platform === 'win32' ? '.tools/s304-py313-env/Scripts/python.exe' : '.tools/s304-py313-env/bin/python';
  const {stdout} = await promisify(execFile)(process.execPath, [checker, python], {timeout: 240000, windowsHide: true});
  assert.deepEqual(JSON.parse(stdout), environment, 'reviewed environment or parity changed');
  const files = new Set([...await collectionV2RemoteManifestPaths(), checker, builder, 'tools/research/prepare-dl30-registration.mjs',
    'tools/ml/requirements-ci.txt', 'tools/research/player-hero-experiment-policy.json', 'tools/research/post-draft-policy.json']);
  const code = {};
  for (const path of [...files].sort()) code[path] = realSha(await readFile(path));
  return {
    format: 'dl30-swiss-preparation-v1', status: 'prepared_for_review', sources, proposal, parentPolicy: parent,
    python, environment, code, exclusions, separatePandaScoreSeriesKeys: refresh.separatePandaScoreSeriesKeys,
    baseSha256: refresh.snapshot.sha256, exclusionsSha256: realSha(JSON.stringify(exclusions)),
    completeGlobalInventory: false, registrationReady: false, registeredAt: null,
    collectionAllowed: false, evaluationAllowed: false, activationAllowed: false,
  };
}

// Publish complete bytes atomically. Retries can reuse an identical file only.
async function publish(bytes) {
  const temporary = output + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, {flag: 'wx'});
    try { await link(temporary, output); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main() {
  const [mode, expected, ...extra] = process.argv.slice(2);
  assert(extra.length === 0 && ((mode === 'prepare' && expected === undefined) ||
    (mode === 'verify' && /^[a-f0-9]{64}$/.test(expected))), 'usage: prepare | verify EXPECTED_PACKAGE_SHA256');
  if (mode === 'verify') assert.equal(realSha(await readFile(output)), expected, 'saved package digest mismatch');
  const result = await build();
  const bytes = JSON.stringify(result) + '\n';
  const digest = realSha(bytes);
  if (mode === 'prepare') await publish(bytes);
  else assert.equal(digest, expected, 'package replay mismatch');
  assert.equal(realSha(await readFile(output)), digest, 'conflicting package on disk');
  console.log(JSON.stringify({mode, path: output, sha256: digest, exclusionsSha256: result.exclusionsSha256,
    maps: result.exclusions.mapIds.length, openDotaSeries: result.exclusions.canonicalSeriesKeys.length,
    pandaScoreMeetings: result.separatePandaScoreSeriesKeys.length, codeFiles: Object.keys(result.code).length,
    registrationReady: false}));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
