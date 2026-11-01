import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { planResearchElo, canonicalContextJson } from '../packages/db/dist/index.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function read(path, limit, expected) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw Error('file_limit');
    const buffer = Buffer.alloc(limit + 1); let count = 0;
    while (count <= limit) { const part = await handle.read(buffer, count, buffer.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > limit) throw Error('file_limit');
    const bytes = buffer.subarray(0, count);
    if (expected !== undefined && sha(bytes) !== expected) throw Error('source_sha_mismatch');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}
const [mode, first, second, third, fourth, ...extra] = process.argv.slice(2);
if (!['create', 'verify'].includes(mode) || !first || !second || !third || !fourth || extra.length ||
  mode === 'verify' && !/^[a-f0-9]{64}$/.test(second)) {
  console.error('Использование: create request.json prior-export.json discovery.json new-plan.json | verify plan.json SHA256 prior-export.json discovery.json');
  process.exit(2);
}
try {
  const saved = mode === 'verify' ? await read(first, 4194304, second) : null;
  const request = saved ? saved.request : await read(first, 65536);
  if (!/^[a-f0-9]{64}$/.test(request?.priorExportSha256 ?? '') || !/^[a-f0-9]{64}$/.test(request?.discoverySha256 ?? '')) throw Error('source_sha_required');
  const prior = await read(mode === 'create' ? second : third, 33554432, request.priorExportSha256);
  const discovery = await read(mode === 'create' ? third : fourth, 8388608, request.discoverySha256);
  const plan = planResearchElo(request, prior, discovery, saved ? saved.registeredAt : new Date().toISOString());
  if (saved && canonicalContextJson(saved) !== canonicalContextJson(plan)) throw Error('plan_replay_mismatch');
  const bytes = JSON.stringify(plan, null, 2) + '\n';
  if (!saved) { const handle = await open(fourth, 'wx'); try { await handle.writeFile(bytes, 'utf8'); } finally { await handle.close(); } }
  console.log(JSON.stringify({ status: saved ? 'plan_verified' : 'plan_frozen', fingerprint: plan.fingerprint,
    artifactSha256: sha(bytes), registeredAt: plan.registeredAt, candidateWarmupMaps: plan.warmup.candidateMaps,
    candidateWarmupSeries: plan.warmup.candidateSeries, excludedWarmupMaps: plan.warmup.excludedMaps,
    holdoutFromAt: request.holdoutFromAt, holdoutUntil: request.holdoutUntil,
    holdoutMetrics: null, trainingReady: false, deployable: false }));
} catch (error) {
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'RESEARCH_PLAN_REJECTED',
    message: error?.code === 'EEXIST' ? 'Файл уже существует. Укажите новое имя.' : 'План отклонён. Проверьте SHA источников, даты и состав серий.' }));
  process.exitCode = 1;
}
