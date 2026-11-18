/** Prepare an offline protocol, not a registration or collection authorization. */
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, relative, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {boundedJson, digest, sha} from './post-draft-dataset.mjs';

const {z} = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('zod');
const root = fileURLToPath(new URL('../../', import.meta.url));
const policyPath = 'tools/research/player-hero-independent-policy.json';
const oldPolicyPath = 'tools/research/player-hero-experiment-policy.json';
const policy = JSON.parse(await readFile(join(root, policyPath), 'utf8'));
const oldPolicy = JSON.parse(await readFile(join(root, oldPolicyPath), 'utf8'));
export const independentPolicy = () => structuredClone(policy);
const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(x => BigInt(x) <= 9223372036854775807n);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.string().datetime().refine(x => new Date(x).toISOString() === x);
const Series = z.string().refine(x => {
  try { const v = JSON.parse(x); return Array.isArray(v) && v.length === 2 && v[0] === 'opendota'
    && Id.safeParse(v[1]).success && JSON.stringify(v) === x; } catch { return false; }
});
const Model = z.object({featureOrder: z.array(z.string()), coefficients: z.array(z.number().finite()),
  temperature: z.number().gt(.250001).lt(3.999999), intercept: z.literal(0)}).strict();
const Input = z.object({preparedAt: Time, candidateSha256: Sha,
  models: z.object({H1: Model, H2: Model}).strict(),
  exposure: z.object({mapIds: z.array(Id).max(100000), canonicalSeriesKeys: z.array(Series).max(100000),
    unknownSeriesMapIds: z.array(Id).max(100000), latestFrozenEvent: Time}).strict()}).strict();
const numeric = (a,b) => BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const sortedIds = values => [...values].sort(numeric);

export function buildIndependentValidationPlan(raw) {
  const input = Input.parse(raw), exposure = input.exposure;
  for (const values of [exposure.mapIds, exposure.canonicalSeriesKeys, exposure.unknownSeriesMapIds])
    assert.equal(new Set(values).size, values.length, 'duplicate_exposure');
  const maps = new Set(exposure.mapIds);
  assert(exposure.unknownSeriesMapIds.every(id => maps.has(id)), 'foreign_unknown_series_map');
  assert(exposure.latestFrozenEvent < input.preparedAt, 'future_exposure');
  for (const name of ['H1', 'H2']) {
    assert.deepEqual(input.models[name].featureOrder, oldPolicy.models[name].features, 'feature_order_changed');
    assert.equal(input.models[name].coefficients.length, input.models[name].featureOrder.length, 'coefficient_count');
  }
  return {
    format: 'player-hero-independent-plan-v1', preparedAt: input.preparedAt,
    status: 'prepared_not_registered', policy: independentPolicy(),
    candidate: {artifactSha256: input.candidateSha256, models: input.models, H0: 'fixed_sigmoid_existing_elo_logit',
      coefficientSelectionPerformed: false, newFittingPerformed: false},
    inheritedCriteria: {featureContract: structuredClone(oldPolicy.featureContract),
      sampleFloors: structuredClone(oldPolicy.sampleFloors), evaluation: structuredClone(oldPolicy.evaluation),
      missingness: structuredClone(oldPolicy.missingness),
      interpretation: 'unchanged_numeric_criteria_research_only;prospective_evaluator_not_yet_implemented'},
    minimumExposureBlocklist: {mapIds: sortedIds(exposure.mapIds),
      canonicalSeriesKeys: [...exposure.canonicalSeriesKeys].sort(), unknownSeriesMapIds: sortedIds(exposure.unknownSeriesMapIds),
      maps: maps.size, knownSeries: exposure.canonicalSeriesKeys.length, latestFrozenEvent: exposure.latestFrozenEvent,
      completeProjectInventory: false, independentMapsEstablished: 0},
    readiness: {registrationAllowed: false, collectionAllowed: false,
      blockers: [...policy.registrationPrerequisites], currentBuilderEnforcesKnownAt: false,
      sourceClockSemanticsVerified: false, numericalRecipeChangeAllowed: false},
    action: {httpRequests: 0, databaseReads: 0, databaseWrites: 0, trainingPerformed: false,
      newPredictionsPerformed: false, modelActivationPerformed: false},
    releaseGatePassed: false, deployable: false,
  };
}

const refs = {
  experimentPlan: 'docs/evidence/s3-04-player-hero-experiment-plan.json',
  fitArtifact: '.tools/s304-hero-fit-r1/artifact.json',
  fitManifest: '.tools/s304-hero-fit-r1/manifest.json',
  evaluationManifest: '.tools/s304-hero-eval-r1/manifest.json',
  evaluationEvidence: 'docs/evidence/s3-04-player-hero-experiment-evaluation.json',
  errorAudit: '.tools/s304-hero-error-audit-r1.json',
  errorAuditEvidence: 'docs/evidence/s3-04-player-hero-error-audit.json',
};

async function checkedFile(path, expected) {
  const full = resolve(root, path), rel = relative(root, full);
  assert(rel && !rel.startsWith('..') && !rel.includes(':'), 'source_outside_repository');
  assert.equal(sha(await readFile(full)), expected, 'frozen_source_changed');
}

export async function prepareIndependentValidationPlan(preparedAt) {
  const loaded = {};
  for (const [key, path] of Object.entries(refs)) loaded[key] = await boundedJson(join(root, path));
  const em = loaded.evaluationManifest.value, fm = loaded.fitManifest.value, artifact = loaded.fitArtifact.value;
  assert(fm.registeredAt < preparedAt && em.registeredAt < preparedAt, 'preparation_before_source_freeze');
  assert.equal(loaded.evaluationManifest.sha256, loaded.evaluationEvidence.value.artifacts['manifest.json']);
  assert.equal(loaded.fitArtifact.sha256, em.sourceHashes.fitArtifact);
  assert.equal(loaded.fitManifest.sha256, em.sourceHashes.fitManifest);
  assert.equal(loaded.experimentPlan.sha256, em.sourceHashes.plan);
  assert.equal(loaded.errorAudit.sha256, loaded.errorAuditEvidence.value.artifactSha256);
  assert.equal(loaded.errorAudit.value.sourceHashes.manifest, loaded.evaluationManifest.sha256);
  await checkedFile('tools/research/player_hero_error_audit.py', loaded.errorAudit.value.auditCodeSha256);
  for (const entry of [...em.code, ...fm.code, ...Object.values(fm.sources)]) await checkedFile(entry.path, entry.sha256);
  for (const [file, hash] of Object.entries(loaded.evaluationEvidence.value.artifacts))
    await checkedFile(`.tools/s304-hero-eval-r1/${file}`, hash);
  const plan = loaded.experimentPlan.value, {fingerprint, ...body} = plan;
  assert.equal(digest(body), fingerprint, 'experiment_plan_fingerprint');
  assert.deepEqual(plan.policy, oldPolicy, 'development_policy_changed');
  assert.equal(artifact.deployable, false); assert.equal(artifact.syntheticOnly, false);
  const models = {};
  for (const name of ['H1', 'H2']) {
    const m = artifact.models[name];
    assert.equal(m.status, 'fitted'); assert.equal(m.calibration.status, 'fitted');
    models[name] = {featureOrder: m.featureOrder, coefficients: m.coefficients,
      temperature: m.calibration.temperature, intercept: m.intercept};
  }
  const {mapIds, canonicalSeriesKeys, unknownSeriesMapIds, latestFrozenEvent} = plan.exposure;
  const output = buildIndependentValidationPlan({preparedAt, models, candidateSha256: loaded.fitArtifact.sha256,
    exposure: {mapIds, canonicalSeriesKeys, unknownSeriesMapIds, latestFrozenEvent}});
  const code = {};
  for (const path of [policyPath, oldPolicyPath, 'tools/research/player-hero-independent-plan.mjs',
    'tests/node/player-hero-independent-plan.test.mjs', 'tools/research/post-draft-dataset.mjs'])
    code[path] = sha(await readFile(join(root, path)));
  return {...output, inputs: Object.fromEntries(Object.entries(loaded).map(([k,v]) => [k, {path: refs[k], sha256: v.sha256}])), code};
}

async function main() {
  const [mode, path, ...extra] = process.argv.slice(2);
  assert(['prepare','verify'].includes(mode) && path && !extra.length, 'arguments');
  const output = resolve(root, path), rel = relative(join(root,'.tools'), output);
  assert(rel && !rel.startsWith('..') && !rel.includes(':'), 'output_outside_tools');
  const saved = mode === 'verify' ? (await boundedJson(output)).value : null;
  const preparedAt = saved?.preparedAt ?? new Date().toISOString();
  assert(preparedAt <= new Date().toISOString(), 'future_preparation');
  const body = await prepareIndependentValidationPlan(preparedAt), result = {...body, fingerprint: digest(body)};
  if (mode === 'prepare') await writeFile(output, JSON.stringify(result,null,2)+'\n', {flag:'wx'});
  else assert.equal(digest(result), digest(saved), 'plan_replay');
  console.log(JSON.stringify({status: result.status, verified: mode === 'verify', fingerprint: result.fingerprint,
    exposedMaps: result.minimumExposureBlocklist.maps, knownSeries: result.minimumExposureBlocklist.knownSeries,
    registrationAllowed: false, collectionAllowed: false, deployable: false}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => {
  console.error(e.code === 'EEXIST' ? 'План уже существует; используйте verify или отдельную связанную версию.'
    : 'План отклонён: проверьте источники, SHA, реестр раскрытых карт и путь результата.');
  process.exitCode = 1;
});
