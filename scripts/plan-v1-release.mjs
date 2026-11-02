import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { planV1Release, verifyV1ReleasePlan } from '../packages/db/dist/index.js';
const sha = value => createHash('sha256').update(value).digest('hex');
async function read(path, limit, expected) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('release_file_limit');
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) { const part = await file.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > limit) throw Error('release_file_limit');
    const content = bytes.subarray(0, count);
    if (expected !== undefined && sha(content) !== expected) throw Error('release_source_sha_mismatch');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  } finally { await file.close(); }
}
const [mode, first, second, third, fourth, ...extra] = process.argv.slice(2);
if (!['create', 'verify'].includes(mode) || !first || !second || !third || !fourth || extra.length ||
  mode === 'verify' && !/^[a-f0-9]{64}$/.test(second)) {
  console.error('Использование: create request.json catalogue.json development.json new-plan.json | verify plan.json SHA256 catalogue.json development.json');
  process.exit(2);
}
try {
  const saved = mode === 'verify' ? await read(first, 4194304, second) : null;
  const request = saved ? saved.request : await read(first, 65536);
  if (!/^[a-f0-9]{64}$/.test(request?.catalogueSha256 ?? '') || !/^[a-f0-9]{64}$/.test(request?.developmentDatasetSha256 ?? '')) throw Error('release_source_sha_required');
  const catalogue = await read(mode === 'create' ? second : third, 16777216, request.catalogueSha256);
  const development = await read(mode === 'create' ? third : fourth, 67108864, request.developmentDatasetSha256);
  const plan = saved ? verifyV1ReleasePlan(saved, catalogue, development) : planV1Release(request, catalogue, development, new Date().toISOString());
  const bytes = JSON.stringify(plan, null, 2) + '\n';
  if (!saved) { const file = await open(fourth, 'wx'); try { await file.writeFile(bytes, 'utf8'); } finally { await file.close(); } }
  console.log(JSON.stringify({ status: saved ? 'release_plan_verified' : plan.status, fingerprint: plan.fingerprint,
    artifactSha256: sha(bytes), registeredAt: plan.registeredAt, events: plan.request.events.map(e => ({ name: e.name, leagueId: e.leagueId })),
    testFromAt: plan.testFromAt, evaluateNotBefore: plan.evaluateNotBefore,
    sample: plan.qualityPolicy.sample, evaluation: null, trainingReady: false, deployable: false }));
} catch (error) {
  const allowed = ['release_registration_too_late', 'release_evidence_in_future', 'release_catalogue_payload_mismatch',
    'release_event_binding_invalid', 'release_development_overlaps_test', 'release_plan_replay_mismatch', 'release_source_sha_mismatch'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    allowed.includes(error?.message) ? error.message.toUpperCase() : 'RELEASE_PLAN_REJECTED',
    message: error?.code === 'EEXIST' ? 'Файл уже существует; зарегистрированный план не изменён.' :
      'План не зарегистрирован. Проверьте SHA источников, ID турниров, даты и отдельную область проверки Tier 1.' }));
  process.exitCode = 1;
}
