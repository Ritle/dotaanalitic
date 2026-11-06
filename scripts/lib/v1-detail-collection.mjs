import { mkdir, readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collectionManager } from './v1-collection.mjs';
import { bounded, sha, save, loadDiscoveryContext, verifyDiscoveryUnion } from './evaluation-discovery-files.mjs';
import { selectEvaluationDetailBatch } from '../../packages/ingestion/dist/index.js';
import { ResearchEvidenceFilesSchema } from '../../packages/contracts/dist/index.js';

const digest = /^[a-f0-9]{64}$/;
const fail = code => { throw Error(code); };
const read = async (path, expected) => (await bounded(path, 33554432, expected)).data;
const hash = async path => sha(await readFile(path));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const result = (status, extra = {}) => ({ ...extra, status, readyForEvaluation: false, metrics: null, teamAWinProbability: null });
const batchName = n => String(n).padStart(2, '0');
const layout = selections => ({ requiredIds: selections[0]?.allRequiredIds ?? [],
  batches: selections.map(s => ({ batchIndex: s.batchIndex, selectedIds: s.selectedIds })) });
async function directory(path, create = false) {
  if (create && !await exists(path)) await mkdir(path);
  if (await realpath(path) !== path) fail('detail_collection_path');
  return path;
}
async function loadUnion(ctx, path, expected) {
  const context = await loadDiscoveryContext(ctx.configPath);
  return verifyDiscoveryUnion(context, path, expected);
}

/** One pinned union, every fixed 50-map batch, unchanged frozen capture/verification. */
export function detailCollectionManager({ manager = collectionManager(), verifyUnion = loadUnion } = {}) {
  function currentDiscovery(ctx, union) {
    const refs = ctx.rows.filter(r => r.receipt?.status === 'captured').map(r =>
      ({ directory: join(r.directory, 'capture'), manifestSha256: r.receipt.manifestSha256 }));
    const order = refs => [...refs].sort((a, b) => a.manifestSha256.localeCompare(b.manifestSha256));
    return refs.length === ctx.rows.length && equal(order(refs), order(union.runs));
  }
  async function source(ctx, path, expected) {
    if (!digest.test(expected ?? '')) fail('detail_collection_input');
    const unionPath = await realpath(path), parent = dirname(unionPath);
    if (dirname(parent) !== join(ctx.root, 'unions') || unionPath !== join(parent, 'union.json')) fail('detail_collection_union_path');
    const saved = await read(join(parent, 'result.json'));
    if (saved.status !== 'merged' || saved.unionSha256 !== expected || resolve(saved.unionPath) !== unionPath ||
      saved.discoveryConfigSha256 !== ctx.session.discoveryConfigSha256) fail('detail_collection_union_binding');
    const union = await verifyUnion(ctx, unionPath, expected);
    if (union.configSha256 !== ctx.session.discoveryConfigSha256 || union.ledger.scope.planFingerprint !== ctx.session.planFingerprint)
      fail('detail_collection_union_binding');
    const first = selectEvaluationDetailBatch(union.ledger, 0);
    const count = Math.ceil(first.allRequiredIds.length / 50);
    return { unionPath, union, selections: Array.from({ length: count }, (_, i) => selectEvaluationDetailBatch(union.ledger, i)),
      currentDiscovery: currentDiscovery(ctx, union) };
  }
  async function loadPlan(ctx, unionSha256) {
    if (!digest.test(unionSha256 ?? '')) fail('detail_collection_input');
    const root = join(ctx.root, 'details', unionSha256);
    if (!await exists(root)) fail('detail_collection_plan_required');
    await directory(join(ctx.root, 'details')); await directory(join(ctx.root, 'detail-plans')); await directory(root);
    const planSha256 = await hash(join(ctx.root, 'detail-plans', unionSha256 + '.json'));
    const plan = await read(join(root, 'plan.json'), planSha256);
    if (plan.format !== 'v1-detail-collection-v1' || plan.unionSha256 !== unionSha256 ||
      plan.discoveryConfigSha256 !== ctx.session.discoveryConfigSha256 || plan.planFingerprint !== ctx.session.planFingerprint)
      fail('detail_collection_plan_binding');
    const pinned = await source(ctx, plan.unionPath, unionSha256);
    if (!equal(plan.layout, layout(pinned.selections))) fail('detail_collection_plan_binding');
    for (const name of ['attempts', 'batches', 'exports']) await directory(join(root, name));
    return { root, plan, planSha256, ...pinned };
  }
  async function inventory(state) {
    const names = (await readdir(join(state.root, 'batches'))).sort();
    const intents = (await readdir(join(state.root, 'attempts'))).sort();
    if (names.length !== intents.length || names.some((name, i) => !/^\d{2}$/.test(name) ||
      Number(name) >= state.selections.length || intents[i] !== name + '.json')) fail('detail_collection_inventory');
    const rows = [];
    for (const name of names) {
      const path = await directory(join(state.root, 'batches', name));
      const intentSha256 = await hash(join(state.root, 'attempts', name + '.json'));
      const intent = await read(join(path, 'intent.json'), intentSha256);
      if (intent.batchIndex !== Number(name) || intent.planSha256 !== state.planSha256) fail('detail_collection_batch_binding');
      let receipt = await exists(join(path, 'result.json')) ? await read(join(path, 'result.json')) : null;
      if (receipt && (receipt.batchIndex !== intent.batchIndex || receipt.intentSha256 !== intentSha256 ||
        !['captured', 'failed'].includes(receipt.status))) fail('detail_collection_result_binding');
      const failedAttemptPreserved = receipt?.status === 'failed';
      if (await exists(join(path, 'recovery.json'))) {
        const recovered = await read(join(path, 'recovery.json'));
        if (!failedAttemptPreserved || recovered.failedResultSha256 !== await hash(join(path, 'result.json')) ||
          recovered.intentSha256 !== intentSha256 || recovered.batchIndex !== intent.batchIndex || recovered.status !== 'captured')
          fail('detail_collection_result_binding');
        receipt = recovered;
      }
      if (receipt?.status === 'captured') {
        if (!digest.test(receipt.manifestSha256 ?? '')) fail('detail_collection_result_binding');
        await read(join(path, 'capture', 'manifest.json'), receipt.manifestSha256);
      }
      rows.push({ path, intent, intentSha256, receipt, failedAttemptPreserved });
    }
    return rows;
  }
  async function verifyBatch(ctx, state, row, expected) {
    const capture = await directory(join(row.path, 'capture'));
    const manifestSha256 = expected ?? await hash(join(capture, 'manifest.json'));
    const manifest = await read(join(capture, 'manifest.json'), manifestSha256);
    if (manifest.unionSha256 !== state.plan.unionSha256 || manifest.discoveryFingerprint !== state.union.ledger.fingerprint ||
      !equal(manifest.assessment?.selection, state.selections[row.intent.batchIndex])) fail('detail_collection_capture_binding');
    const checked = await ctx.runChild('evaluation-details.mjs', ['verify', ctx.configPath, state.unionPath,
      state.plan.unionSha256, capture, manifestSha256]);
    if (checked.exitCode !== 0 || checked.output.status !== 'details_verified' ||
      checked.output.fingerprint !== manifest.assessment.fingerprint) fail('detail_collection_verify_failed');
    // Only aggregate source diagnostics; do not print raw outcomes or score the holdout.
    const rows = manifest.assessment.assessments;
    return { manifestSha256, selected: rows.length, sourceEligible: rows.filter(r => r.sourceEligible).length,
      sourceIneligible: rows.filter(r => !r.sourceEligible).length,
      failedFetches: rows.filter(r => r.reasons.includes('DETAIL_FETCH_FAILED')).length };
  }
  async function finish(ctx, state, row, recovered, expected) {
    const verified = await verifyBatch(ctx, state, row, expected);
    const receipt = { status: 'captured', batchIndex: row.intent.batchIndex, intentSha256: row.intentSha256,
      ...verified, recovered, recordedAt: ctx.now() };
    if (row.receipt?.status === 'failed') {
      receipt.failedResultSha256 = await hash(join(row.path, 'result.json'));
      await save(join(row.path, 'recovery.json'), receipt);
    } else await save(join(row.path, 'result.json'), receipt);
    return receipt;
  }
  async function init(root, collectionSha, unionPath, unionSha) {
    return manager.withSession(root, collectionSha, async ctx => {
      const pinned = await source(ctx, unionPath, unionSha);
      if (!pinned.currentDiscovery) fail('detail_collection_stale_union');
      const parent = await directory(join(ctx.root, 'details'), true);
      const plans = await directory(join(ctx.root, 'detail-plans'), true);
      const path = join(parent, unionSha);
      if (await exists(path)) {
        const state = await loadPlan(ctx, unionSha);
        return result('details_already_prepared', { unionSha256: unionSha, planSha256: state.planSha256, requiredBatches: state.selections.length });
      }
      const plan = { format: 'v1-detail-collection-v1', createdAt: ctx.now(), unionPath: pinned.unionPath, unionSha256: unionSha,
        discoveryConfigSha256: ctx.session.discoveryConfigSha256, planFingerprint: ctx.session.planFingerprint, layout: layout(pinned.selections) };
      const ref = await save(join(plans, unionSha + '.json'), plan);
      await mkdir(path); await save(join(path, 'plan.json'), plan);
      for (const name of ['attempts', 'batches', 'exports']) await mkdir(join(path, name));
      return result('details_prepared', { unionSha256: unionSha, planSha256: ref.sha256, requiredBatches: pinned.selections.length,
        requiredMaps: pinned.selections[0]?.allRequiredIds.length ?? 0 });
    });
  }
  async function status(root, collectionSha, unionSha) {
    return manager.withSession(root, collectionSha, async ctx => {
      if (unionSha === undefined) {
        const plans = await exists(join(ctx.root, 'detail-plans')) ? await readdir(await directory(join(ctx.root, 'detail-plans'))) : [];
        if (plans.some(n => !/^[a-f0-9]{64}\.json$/.test(n))) fail('detail_collection_inventory');
        return result('detail_plans', { plans: plans.sort().map(n => n.slice(0, -5)), testFromAt: ctx.session.testFromAt,
          snapshotAt: ctx.session.snapshotAt, providerRequests: 0 });
      }
      const state = await loadPlan(ctx, unionSha), rows = await inventory(state), batches = [];
      for (const row of rows) batches.push({ batchIndex: row.intent.batchIndex, status: row.receipt?.status ?? 'interrupted',
        failedAttemptPreserved: row.failedAttemptPreserved,
        ...(row.receipt?.status === 'captured' ? await verifyBatch(ctx, state, row, row.receipt.manifestSha256) : {}) });
      const missing = state.selections.filter(s => !batches.some(b => b.batchIndex === s.batchIndex && b.status === 'captured')).map(s => s.batchIndex);
      return result('detail_status', { unionSha256: unionSha, currentDiscovery: state.currentDiscovery,
        requiredBatches: state.selections.length, batches, missing, inventoryComplete: missing.length === 0,
        sourceStatus: state.union.ledger.status, providerRequests: 0 });
    });
  }
  async function capture(root, collectionSha, unionSha, batchIndex) {
    if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex > 99) fail('detail_collection_input');
    return manager.withSession(root, collectionSha, async ctx => {
      const state = await loadPlan(ctx, unionSha), rows = await inventory(state);
      if (batchIndex >= state.selections.length) fail('detail_collection_batch_range');
      const prior = rows.find(r => r.intent.batchIndex === batchIndex);
      if (prior) {
        if (prior.receipt?.status !== 'captured') fail('detail_collection_recovery_required');
        return result('detail_already_captured', { batchIndex, currentDiscovery: state.currentDiscovery,
          ...await verifyBatch(ctx, state, prior, prior.receipt.manifestSha256) });
      }
      const at = ctx.now();
      if (at < ctx.session.testFromAt) return result('not_started', { testFromAt: ctx.session.testFromAt, providerRequests: 0 });
      if (at >= ctx.session.snapshotAt) fail('collection_source_deadline');
      if (!state.currentDiscovery) fail('detail_collection_stale_union');
      if (rows.some(r => r.receipt?.status !== 'captured')) fail('detail_collection_recovery_required');
      const name = batchName(batchIndex), path = join(state.root, 'batches', name);
      const intent = { batchIndex, createdAt: at, planSha256: state.planSha256 };
      const ref = await save(join(state.root, 'attempts', name + '.json'), intent);
      await mkdir(path); await save(join(path, 'intent.json'), intent);
      const row = { path, intent, intentSha256: ref.sha256, receipt: null };
      try {
        const saved = await ctx.runChild('evaluation-details.mjs', ['capture', ctx.configPath, state.unionPath,
          state.plan.unionSha256, String(batchIndex), join(path, 'capture')]);
        if (saved.exitCode !== 0 || saved.output.status !== 'details_captured' || !digest.test(saved.output.manifestSha256 ?? ''))
          fail('detail_collection_capture_failed');
        return result('detail_captured', await finish(ctx, state, row, false, saved.output.manifestSha256));
      } catch {
        if (!await exists(join(path, 'result.json'))) await save(join(path, 'result.json'),
          { status: 'failed', batchIndex, intentSha256: ref.sha256, recordedAt: ctx.now() });
        fail('detail_collection_recovery_required');
      }
    });
  }
  async function recover(root, collectionSha, unionSha) {
    return manager.withSession(root, collectionSha, async ctx => {
      const state = await loadPlan(ctx, unionSha), rows = await inventory(state);
      const pending = rows.filter(r => r.receipt?.status !== 'captured');
      for (const row of pending) await finish(ctx, state, row, true);
      return result('details_recovered', { batches: pending.length, currentDiscovery: state.currentDiscovery, providerRequests: 0 });
    });
  }
  async function exportEvidence(root, collectionSha, unionSha) {
    return manager.withSession(root, collectionSha, async ctx => {
      const state = await loadPlan(ctx, unionSha), rows = await inventory(state);
      if (!state.currentDiscovery) fail('detail_collection_stale_union');
      if (rows.length !== state.selections.length || rows.some(r => r.receipt?.status !== 'captured')) fail('detail_collection_incomplete');
      const batches = []; let sourceIneligible = 0;
      for (const row of rows) {
        const checked = await verifyBatch(ctx, state, row, row.receipt.manifestSha256);
        sourceIneligible += checked.sourceIneligible;
        batches.push({ directory: join(row.path, 'capture'), manifestSha256: checked.manifestSha256 });
      }
      const path = join(state.root, 'exports', randomUUID()); await mkdir(path);
      const evidence = ResearchEvidenceFilesSchema.parse({ configPath: ctx.configPath, configSha256: ctx.session.discoveryConfigSha256,
        unionPath: state.unionPath, unionSha256: unionSha, batches });
      const file = join(path, 'evidence.json'), ref = await save(file, evidence);
      const output = result('detail_evidence_exported', { evidencePath: file, evidenceSha256: ref.sha256,
        requiredBatches: batches.length, sourceIneligible, sourceStatus: state.union.ledger.status, providerRequests: 0 });
      await save(join(path, 'result.json'), output); return output;
    });
  }
  // Import tooling shares the lock and must consume the complete, replayed source set.
  async function withDetails(root, collectionSha, unionSha, operation, { allowStale = false } = {}) {
    return manager.withSession(root, collectionSha, async ctx => {
      const state = await loadPlan(ctx, unionSha), rows = await inventory(state);
      if (!state.currentDiscovery && !allowStale) fail('detail_collection_stale_union');
      if (rows.length !== state.selections.length || rows.some(r => r.receipt?.status !== 'captured')) fail('detail_collection_incomplete');
      for (const row of rows) await verifyBatch(ctx, state, row, row.receipt.manifestSha256);
      const evidence = ResearchEvidenceFilesSchema.parse({ configPath: ctx.configPath, configSha256: ctx.session.discoveryConfigSha256,
        unionPath: state.unionPath, unionSha256: unionSha,
        batches: rows.map(row => ({ directory: join(row.path, 'capture'), manifestSha256: row.receipt.manifestSha256 })) });
      return operation({ ...ctx, currentDiscovery: state.currentDiscovery, detailRoot: state.root, selections: state.selections, evidence });
    });
  }
  return { init, status, capture, recover, export: exportEvidence, withDetails };
}
