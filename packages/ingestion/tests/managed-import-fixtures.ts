import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { releasePlanFixture } from '../../db/tests/v1-release-plan-fixtures.js';
import { prepareV1Data } from '../../db/src/v1-data.js';
import { canonicalContextJson } from '../../db/src/temporal.js';
import { releaseEvidenceFixture, releaseSha } from './v1-release-evidence-fixtures.js';
import { buildEvaluationDiscoveryLedger } from '../src/evaluation-discovery.js';
import { validateEvaluationDetails, selectEvaluationDetailBatch } from '../src/evaluation-details.js';

export async function managedImportFixture(multiBatch = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dota-import-cli-'));
  const cleanup = async () => { if (!dir.startsWith(resolve(tmpdir()) + sep + 'dota-import-cli-')) throw Error('unsafe_cleanup'); await rm(dir, { recursive: true, force: true }); };
  const save = async (name: string, value: unknown) => {
    const path = join(dir, name), bytes = JSON.stringify(value); await writeFile(path, bytes, { flag: 'wx' });
    return { path, sha256: releaseSha(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const sealed = (body: object) => ({ ...body, fingerprint: releaseSha(canonicalContextJson(body)) });
  try {
    const base: ReturnType<typeof releasePlanFixture> = JSON.parse(JSON.stringify(releasePlanFixture()).replaceAll('2026-', '2025-'), (key, value: unknown) =>
      key.endsWith('Us') && typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) >= BigInt(Date.parse('2026-01-01')) * 1000n
        ? (BigInt(value) - 365n * 86400000000n).toString() : value);
    base.development = prepareV1Data(base.development.source);
    const catalogue = await save('catalogue.json', base.catalogue), development = await save('development.json', base.development);
    base.request.catalogueSha256 = catalogue.sha256; base.request.developmentDatasetSha256 = development.sha256;
    const f = releaseEvidenceFixture(base), plan = await save('plan.json', f.plan);
    let ledger = f.ledger, batches = f.batches;
    if (multiBatch) {
      const last = f.inventory.source.candidates.find(m => m.matchId === '202')!, first = f.inventory.source.candidates.find(m => m.matchId === '201')!;
      last.matchId = '400'; last.seriesId = first.seriesId;
      if (last.outcome.status !== 'verified') throw Error('fixture_outcome');
      last.outcome.matchId = '400'; last.outcome.seriesId = first.seriesId;
      const detail = structuredClone(f.detailEntries[3]!); detail.matchId = '400'; detail.endpoint = '/matches/400'; detail.observation.source.endpoint = detail.endpoint;
      const raw = JSON.parse(detail.observation.rawBody); raw.match_id = '400'; raw.series_id = '201';
      detail.observation.rawBody = JSON.stringify(raw); detail.observation.source.payloadSha256 = releaseSha(detail.observation.rawBody);
      last.outcome.sourceEvidence.payloadSha256 = detail.observation.source.payloadSha256;
      const missing = Array.from({ length: 49 }, (_, i) => ({ ...f.rows[0]!, match_id: String(300 + i), series_id: String(300 + i) }));
      const rows = [f.rows[0]!, ...missing, { ...f.rows[1]!, match_id: '400', series_id: '201' }], rawBody = JSON.stringify(rows);
      f.entries[0] = { ...f.entries[0]!, rawBody, payloadSha256: releaseSha(rawBody) };
      ledger = buildEvaluationDiscoveryLedger(f.ledger.scope, f.entries, f.at, f.at, f.limits, []);
      batches = [0, 1].map(i => {
        const selection = selectEvaluationDetailBatch(ledger, i);
        const entries = [...f.detailEntries.slice(0, 2), ...selection.selectedIds.map(id => id === '201' ? f.detailEntries[2]! : id === '400' ? detail :
          { status: 'failed' as const, endpoint: '/matches/' + id, matchId: id, failedAt: f.at, code: 'synthetic_missing' })];
        return validateEvaluationDetails(ledger, entries, i, f.at, f.at);
      });
    }
    const config = await save('config.json', { kind: 'v1', planPath: plan.path, planSha256: plan.sha256,
      evidenceAPath: catalogue.path, evidenceBPath: development.path, limits: f.limits });
    await mkdir(join(dir, 'discovery')); const request = await save('discovery/request.json', {}), receipts = [];
    for (const [i, entry] of f.entries.entries()) {
      const name = `receipt-${String(i).padStart(3, '0')}.json`, ref = await save('discovery/' + name, entry); receipts.push({ ...ref, path: name });
    }
    const discovery = await save('discovery/manifest.json', sealed({ format: 'evaluation-discovery-run-v1', configSha256: config.sha256, request, receipts, ledger }));
    const union = await save('union.json', sealed({ schemaVersion: 1, format: 'evaluation-discovery-union-v1', configSha256: config.sha256,
      runs: [{ directory: join(dir, 'discovery'), manifestSha256: discovery.sha256 }], ledger,
      aggregation: 'all_supplied_runs_union_no_removal_or_conflict_overwrite', sourceHistoryCompleteness: 'only_explicitly_supplied_runs', metrics: null, deployable: false }));
    const refs = [];
    for (const [index, batch] of batches.entries()) {
      const folder = 'detail-' + index; await mkdir(join(dir, folder));
      const request = await save(folder + '/request.json', {}), receipts = [];
      // Keep the original source entries, including every failed fetch.
      const entries = [...f.detailEntries.slice(0, 2), ...batch.report.selection.selectedIds.map(id => {
        if (!multiBatch) return f.detailEntries.find(e => e.matchId === id)!;
        const match = batch.matches.find(m => m.matchId === id)!;
        return match.observation ? { status: 'captured', endpoint: '/matches/' + id, matchId: id,
          observation: { rawBody: match.observation.rawBody, source: match.observation.source } } :
          { status: 'failed', endpoint: '/matches/' + id, matchId: id, failedAt: f.at, code: 'synthetic_missing' };
      })];
      for (const [i, entry] of entries.entries()) {
        const name = `receipt-${String(i).padStart(3, '0')}.json`, ref = await save(folder + '/' + name, entry); receipts.push({ ...ref, path: name });
      }
      const manifest = await save(folder + '/manifest.json', sealed({ format: 'evaluation-details-capture-v1', unionSha256: union.sha256,
        discoveryFingerprint: ledger.fingerprint, request, receipts, assessment: batch.report }));
      refs.push({ directory: join(dir, folder), manifestSha256: manifest.sha256 });
    }
    const evidence = { configPath: config.path, configSha256: config.sha256, unionPath: union.path, unionSha256: union.sha256, batches: refs };
    const evidenceFile = await save('evidence.json', evidence);
    const dataset = prepareV1Data({ ...f.inventory.source, request: { schemaVersion: 1, profile: 'pre-match-player-elo-data-v1', purpose: 'development_only',
      fromAt: f.plan.request.warmupFromAt, toAt: f.plan.request.snapshotAt, snapshotAt: f.plan.request.snapshotAt, maxMaps: 5000 } });
    const datasetFile = await save('dataset.json', dataset);
    return { dir, f, ledger, batches, evidence, evidenceFile, datasetFile, save, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
