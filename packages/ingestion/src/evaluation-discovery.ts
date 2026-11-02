import { createHash } from 'node:crypto';
import { EvaluationDiscoveryRowsSchema, EvaluationDiscoveryScopeSchema, EvaluationDiscoveryEntrySchema,
  EvaluationDiscoveryLimitsSchema, type EvaluationDiscoveryScope, type EvaluationDiscoveryEntry,
  type EvaluationDiscoveryLimits } from '@dota/contracts';
import { canonicalContextJson } from '@dota/db';
import { OpenDotaClient, OpenDotaError } from './opendota/client.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => sha(canonicalContextJson(v));
const idOrder = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
type Row = ReturnType<typeof EvaluationDiscoveryRowsSchema.parse>[number];
export function discoveryRows(entry: EvaluationDiscoveryEntry) {
  if (entry.status !== 'captured') return [];
  if (sha(entry.rawBody) !== entry.payloadSha256) throw Error('discovery_payload_sha_mismatch');
  return EvaluationDiscoveryRowsSchema.parse(JSON.parse(entry.rawBody));
}
function mayTarget(scope: EvaluationDiscoveryScope, row: Row) {
  const start = row.start_time === null ? null : new Date(row.start_time * 1000).toISOString();
  return scope.windows.some(w => (w.leagueId === null || row.leagueid === null || row.leagueid === w.leagueId) &&
    (start === null || start >= w.fromAt && start < w.until));
}

/** Reconstruct the required request order; omitted pages/leagues cannot be hidden by editing summary counters. */
export function discoveryTraceStoppingReasons(scope: EvaluationDiscoveryScope, entries: EvaluationDiscoveryEntry[],
  limits: EvaluationDiscoveryLimits, startedAt: string) {
  let cursorIndex = 0;
  const stop: string[] = [], active = scope.windows.some(w => w.fromAt <= startedAt);
  const consume = (endpoint: string) => {
    const entry = entries[cursorIndex++];
    if (!entry || entry.endpoint !== endpoint) throw Error('discovery_request_trace_mismatch');
    return { entry, rows: discoveryRows(entry) };
  };
  if (active) {
    const leagues = new Set(scope.kind === 'v1' ? scope.windows.filter(w => w.fromAt <= startedAt).map(w => w.leagueId!) : []);
    if (scope.kind === 'e1') {
      let cursor: string | undefined;
      for (let page = 0; page < limits.maxProPages; page++) {
        const { entry, rows } = consume('/proMatches' + (cursor === undefined ? '' : `?less_than_match_id=${cursor}`));
        if (entry.status === 'failed' || !rows.length) break;
        for (const row of rows) if (mayTarget(scope, row) && row.leagueid !== null) leagues.add(row.leagueid);
        if (cursor !== undefined && rows.some(r => BigInt(r.match_id) >= BigInt(cursor!))) { stop.push('PAGINATION_NOT_ADVANCING'); break; }
        cursor = rows.map(r => r.match_id).sort(idOrder)[0]!;
        if (page === limits.maxProPages - 1) stop.push('PRO_PAGE_LIMIT');
      }
    }
    if (leagues.size > limits.maxLeagues) stop.push('LEAGUE_LIMIT');
    else for (const id of [...leagues].sort(idOrder)) consume(`/leagues/${id}/matches`);
  }
  if (cursorIndex !== entries.length) throw Error('discovery_request_trace_mismatch');
  return stop;
}

/** Lossless metadata ledger: every returned numeric match ID has a disposition, never a verified training label. */
export function buildEvaluationDiscoveryLedger(scopeInput: unknown, entriesInput: unknown[], startedAt: string, completedAt: string,
  limitsInput: unknown, stoppingReasons: string[]) {
  const scope = EvaluationDiscoveryScopeSchema.parse(scopeInput), limits = EvaluationDiscoveryLimitsSchema.parse(limitsInput);
  if (!Number.isFinite(Date.parse(startedAt)) || new Date(startedAt).toISOString() !== startedAt ||
    !Number.isFinite(Date.parse(completedAt)) || new Date(completedAt).toISOString() !== completedAt || completedAt < startedAt) throw Error('discovery_clock_invalid');
  const entries = entriesInput.map(e => EvaluationDiscoveryEntrySchema.parse(e));
  if (entries.length > 200 || entries.some((e, i) => e.sequence !== i ||
    (e.status === 'captured' ? e.fetchedAt : e.failedAt) < startedAt || (e.status === 'captured' ? e.fetchedAt : e.failedAt) > completedAt)) throw Error('discovery_entry_order_or_clock');
  const observations = new Map<string, { row: Row; sequence: number; endpoint: string }[]>();
  const endpointConflicts = new Set<string>();
  let returnedRows = 0;
  for (const entry of entries) for (const row of discoveryRows(entry)) {
    returnedRows++;
    const group = observations.get(row.match_id) ?? [];
    group.push({ row, sequence: entry.sequence, endpoint: entry.endpoint }); observations.set(row.match_id, group);
    const match = /^\/leagues\/([1-9]\d*)\/matches$/.exec(entry.endpoint);
    if (match && row.leagueid !== null && row.leagueid !== match[1]) endpointConflicts.add(row.match_id);
  }
  // Never drop IDs on overflow; persist the inventory but make it explicitly unfit for evaluation.
  const candidates = [...observations].sort(([a], [b]) => idOrder(a, b)).map(([matchId, variants]) => {
    const reasons: string[] = [];
    const fields = ['start_time', 'leagueid', 'series_id', 'radiant_team_id', 'dire_team_id'] as const;
    const merged = { ...variants[0]!.row };
    for (const field of fields) {
      const values = [...new Set(variants.map(v => v.row[field]).filter(v => v !== null))];
      if (values.length > 1) reasons.push(`CONFLICT_${field.toUpperCase()}`);
      if (field === 'start_time') merged.start_time = values[0] as number | undefined ?? null;
      else merged[field] = values[0] as string | undefined ?? null;
    }
    if (endpointConflicts.has(matchId)) reasons.push('LEAGUE_ENDPOINT_CONFLICT');
    const conflict = reasons.length > 0;
    const possibleTarget = variants.some(v => mayTarget(scope, v.row) ||
      // Conflicting provider league metadata must not erase an observed target endpoint candidate.
      /^\/leagues\/([1-9]\d*)\/matches$/.test(v.endpoint) &&
      mayTarget(scope, { ...v.row, leagueid: v.endpoint.split('/')[2]! }));
    if (merged.start_time === null) reasons.push('START_UNKNOWN');
    if (merged.leagueid === null) reasons.push('LEAGUE_UNKNOWN');
    if (merged.series_id === null) reasons.push('SERIES_UNKNOWN');
    if (merged.radiant_team_id === null || merged.dire_team_id === null) reasons.push('TEAMS_UNKNOWN');
    else if (merged.radiant_team_id === merged.dire_team_id) reasons.push('TEAMS_IDENTICAL');
    const scopeUnknown = merged.start_time === null || scope.kind === 'v1' && merged.leagueid === null;
    return { matchId, metadata: merged, possibleTarget,
      disposition: conflict ? 'metadata_conflict' : !possibleTarget ? 'outside_scope' : scopeUnknown ? 'scope_uncertain' : 'pending_detail_verification',
      seriesKey: merged.series_id === null ? null : `opendota:${merged.series_id}`,
      reasons, observations: variants.map(v => ({ sequence: v.sequence, endpoint: v.endpoint, metadata: v.row })) };
  });
  const targetSeries = new Set(candidates.filter(c => c.possibleTarget).flatMap(c => c.observations.flatMap(o => o.metadata.series_id === null ? [] : [`opendota:${o.metadata.series_id}`])));
  for (const candidate of candidates) if (candidate.disposition === 'outside_scope' && candidate.seriesKey !== null && targetSeries.has(candidate.seriesKey)) {
    candidate.disposition = 'related_series_member'; candidate.reasons.push('OUTSIDE_WINDOW_SERIES_SIBLING');
  }
  const stop = [...new Set(stoppingReasons)].sort();
  if (candidates.length > scope.maxMaps) stop.push('INVENTORY_LIMIT');
  if (completedAt > scope.snapshotAt) stop.push('AFTER_EVALUATION_SNAPSHOT');
  const failures = entries.filter(e => e.status === 'failed').length;
  const firstStart = scope.windows.map(w => w.fromAt).sort()[0]!;
  const body = { schemaVersion: 1, format: 'evaluation-discovery-ledger-v1', scope, startedAt, completedAt, limits,
    receipts: entries.map(e => e.status === 'captured' ? { status: e.status, sequence: e.sequence, endpoint: e.endpoint,
      fetchedAt: e.fetchedAt, payloadSha256: e.payloadSha256 } : e),
    candidates, summary: { sourceResponses: entries.length - failures, sourceFailures: failures, returnedRows,
      uniqueMaps: candidates.length, possibleTargetMaps: candidates.filter(c => c.possibleTarget).length,
      pendingDetails: candidates.filter(c => c.disposition === 'pending_detail_verification').length,
      uncertainMaps: candidates.filter(c => c.disposition === 'scope_uncertain' || c.disposition === 'metadata_conflict').length,
      relatedSeriesMembers: candidates.filter(c => c.disposition === 'related_series_member').length },
    status: failures || stop.length ? 'partial' : completedAt < firstStart ? 'not_started' : 'discovered', stoppingReasons: stop,
    remoteCompleteness: 'unknown', proEligibility: 'not_verified', coverage: 'not_evaluated',
    metrics: null, trainingReady: false, deployable: false, teamAWinProbability: null };
  return { ...body, fingerprint: hash(body) };
}

/** Bounded metadata-only discovery using the existing retry/timeout/quota client. Receipt callback persists before continuing. */
export async function collectEvaluationDiscovery(scopeInput: unknown, client: OpenDotaClient,
  persist: (entry: EvaluationDiscoveryEntry) => Promise<void>, limitsInput: unknown = { maxProPages: 5, maxLeagues: 10 }, now = () => new Date().toISOString()) {
  const scope = EvaluationDiscoveryScopeSchema.parse(scopeInput), limits: EvaluationDiscoveryLimits = EvaluationDiscoveryLimitsSchema.parse(limitsInput);
  const startedAt = now(), entries: EvaluationDiscoveryEntry[] = [], stopping: string[] = [];
  const active = scope.windows.some(w => w.fromAt <= startedAt);
  async function capture(endpoint: string, operation: () => ReturnType<OpenDotaClient['getProMatchDiscovery']>) {
    let entry: EvaluationDiscoveryEntry;
    try {
      const observation = await operation();
      entry = { status: 'captured', sequence: entries.length, endpoint, fetchedAt: observation.source.fetchedAt,
        payloadSha256: observation.source.payloadSha256, rawBody: observation.rawBody };
    } catch (e) {
      entry = { status: 'failed', sequence: entries.length, endpoint, failedAt: now(), code: e instanceof OpenDotaError ? e.code : 'unexpected_provider_error' };
    }
    // Persistence errors must stop the collector, never be mislabeled as a recoverable provider failure.
    await persist(entry); entries.push(entry);
    return discoveryRows(entry);
  }
  if (active) {
    const leagueIds = new Set(scope.kind === 'v1' ? scope.windows.filter(w => w.fromAt <= startedAt).map(w => w.leagueId!) : []);
    if (scope.kind === 'e1') {
      let cursor: string | undefined;
      for (let page = 0; page < limits.maxProPages; page++) {
        const rows = await capture('/proMatches' + (cursor === undefined ? '' : `?less_than_match_id=${cursor}`), () => client.getProMatchDiscovery(cursor));
        if (entries.at(-1)!.status === 'failed' || rows.length === 0) break;
        for (const row of rows) if (mayTarget(scope, row) && row.leagueid !== null) leagueIds.add(row.leagueid);
        const next = rows.map(r => r.match_id).sort(idOrder)[0]!;
        if (cursor !== undefined && rows.some(r => BigInt(r.match_id) >= BigInt(cursor!))) { stopping.push('PAGINATION_NOT_ADVANCING'); break; }
        cursor = next;
        if (page === limits.maxProPages - 1) stopping.push('PRO_PAGE_LIMIT');
      }
    }
    const sorted = [...leagueIds].sort(idOrder);
    if (sorted.length > limits.maxLeagues) stopping.push('LEAGUE_LIMIT');
    // Do not silently take the first convenient leagues when the configured budget cannot cover all observed leagues.
    else for (const id of sorted) await capture(`/leagues/${id}/matches`, () => client.getLeagueMatchDiscovery(id));
  }
  const completedAt = now();
  const traceStop = discoveryTraceStoppingReasons(scope, entries, limits, startedAt);
  if (canonicalContextJson([...traceStop].sort()) !== canonicalContextJson([...stopping].sort())) throw Error('discovery_internal_trace_mismatch');
  return { entries, ledger: buildEvaluationDiscoveryLedger(scope, entries, startedAt, completedAt, limits, traceStop) };
}
