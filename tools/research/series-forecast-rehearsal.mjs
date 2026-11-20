import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {link, mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {V1FeatureHistorySchema, V1FeatureScenarioSchema} from '../../packages/contracts/dist/v1-features.js';
import {buildV1Features} from '../../packages/prediction/dist/v1-features.js';
import {eloLink} from '../../packages/prediction/dist/v1-candidate.js';
import {seriesCandidateProbability, SERIES_CANDIDATE_POLICY} from '../../packages/prediction/dist/series/candidate.js';

const {z} = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('zod');
const id = z.string().regex(/^[1-9]\d{0,18}$/);
const utc = z.iso.datetime({precision:3});
const inputSchema = z.object({
  format:z.literal('synthetic-bo3-rehearsal-v1'),
  target:z.object({provider:z.literal('synthetic'), editionId:id, seriesId:id, bestOf:z.literal(3),
    teamAId:id, teamBId:id, scheduledAt:utc, scheduleObservedAt:utc}).strict(),
  history:V1FeatureHistorySchema, scenario:V1FeatureScenarioSchema
}).strict();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const us = iso => BigInt(Date.parse(iso)) * 1000n + BigInt((iso.match(/\.(\d+)Z$/)?.[1] ?? '').padEnd(6,'0').slice(3,6));

async function version() {
  const files = ['packages/prediction/dist/v1-features.js','packages/prediction/dist/v1-candidate.js',
    'packages/prediction/dist/series/candidate.js','tools/research/series-validation-policy.json',
    'tools/research/series-forecast-rehearsal.mjs'];
  return {node:process.version, files:Object.fromEntries(await Promise.all(files.map(async path=>
    [path,sha(await readFile(new URL('../../'+path,import.meta.url)))])))};
}

function snapshot(input, recordedAt, runtime) {
  const {target,history,scenario} = input;
  const cutoff = BigInt(scenario.cutoffAtUs);
  const snapshotAt = BigInt(history.snapshotAtUs);
  assert(history.syntheticOnly && scenario.targetMatchId === null && scenario.lineup.basis !== 'actual_lineup_reconstructed',
    'synthetic pre-series inputs required');
  assert(BigInt(target.teamAId) < BigInt(target.teamBId), 'team orientation');
  const selected = BigInt(scenario.lineup.selectedAtUs);
  assert(selected <= snapshotAt && selected < cutoff && us(target.scheduleObservedAt) <= cutoff &&
    snapshotAt <= cutoff && cutoff <= us(recordedAt) &&
    us(recordedAt) < us(target.scheduledAt), 'outside pre-series window');
  assert(history.identities.every(p=>[p.fetchedAt,p.knownAt,p.eventAt].every(t=>t === null || us(t) <= snapshotAt)),
    'identity after snapshot');
  assert(history.maps.every(m=>m.seriesKey !== JSON.stringify([target.provider,target.seriesId]) &&
    BigInt(m.completedAtUs) < cutoff && BigInt(m.labelVerifiedAtUs) <= snapshotAt), 'history outside scope');
  const features = buildV1Features(history,scenario);
  const map = features.features === null ? null : eloLink(features.features.eloDifference);
  return {format:'bo3-series-rehearsal-receipt-v1', input, runtime, recordedAt,
    issuedAt:map === null ? null : recordedAt, status:features.status, reasons:features.reasons,
    candidate:SERIES_CANDIDATE_POLICY, features, baseMapProbability:map,
    seriesProbability:map === null ? null : seriesCandidateProbability(map,3),
    syntheticOnly:true, independentEvaluation:false, deployable:false};
}

async function existing(path, input, runtime) {
  let bytes;
  try { bytes = await readFile(path); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const saved = JSON.parse(bytes);
  assert.deepEqual(saved.input,input,'series already has a different input');
  assert.deepEqual(saved,snapshot(input,utc.parse(saved.recordedAt),runtime),'receipt replay mismatch');
  return {sha256:sha(bytes),status:saved.status,path};
}

// A complete temporary file is linked into place exactly once per synthetic series.
// Local file time is sufficient for rehearsal only. It does not attest real-world issuance.
export async function captureRehearsal(directory, raw) {
  const input = inputSchema.parse(raw);
  const path = join(directory,'series-'+input.target.seriesId+'.json');
  const runtime = await version();
  await mkdir(directory,{recursive:true});
  const prior = await existing(path,input,runtime);
  if (prior) return prior;
  const receipt = snapshot(input,new Date().toISOString(),runtime);
  const bytes = JSON.stringify(receipt)+'\n';
  const temporary = join(directory,randomUUID()+'.tmp');
  try {
    await writeFile(temporary,bytes,{flag:'wx',flush:true});
    assert(Date.now() < Date.parse(input.target.scheduledAt),'target start reached during preparation');
    try { await link(temporary,path); }
    catch (e) { if (e.code !== 'EEXIST') throw e; return await existing(path,input,runtime); }
  } finally { await unlink(temporary).catch(e=>{if(e.code !== 'ENOENT') throw e;}); }
  return {sha256:sha(bytes),status:receipt.status,path};
}

// The PostgreSQL rehearsal supplies the preparation clock. Its commit witness is stored separately.
export async function prepareSeriesRehearsal(raw, preparedAt) {
  return snapshot(inputSchema.parse(raw),z.iso.datetime({precision:6}).parse(preparedAt),await version());
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [inputPath,...extra] = process.argv.slice(2);
  assert(inputPath && !extra.length,'usage: node tools/research/series-forecast-rehearsal.mjs SYNTHETIC_INPUT.json');
  const input = JSON.parse(await readFile(inputPath,'utf8'));
  console.log(JSON.stringify(await captureRehearsal('.tools/s309-series-rehearsal',input)));
}
