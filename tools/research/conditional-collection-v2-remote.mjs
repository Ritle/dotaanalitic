import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {OpenDotaClient, OpenDotaError} from '../../packages/ingestion/dist/opendota/client.js';
import {PostgresProviderBudget} from '../../packages/ingestion/dist/quota.js';
import {archiveLimits} from './conditional-blob-archive.mjs';
import {CollectionV2Command, ConditionalCollectionV2Journal} from './conditional-collection-v2-journal.mjs';
import {ConditionalCollectionV2Discovery} from './conditional-collection-v2-discovery.mjs';
import {transportV2Command} from './conditional-collection-v2-transport.mjs';
import {collectionV2RefreshManifestPaths, verifyCollectionV2RefreshManifest} from './conditional-collection-v2-refresh.mjs';

const id = z.string().uuid().transform(value => value.toLowerCase());
export const RemoteStepRequest = z.object({
  mode: z.literal('opendota-remote'), ownerId: id, registrationId: id, operationId: id,
  registrationSha256: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();
const newFiles = ['tools/research/conditional-collection-v2-remote.mjs', 'tools/research/run-conditional-collection-v2-remote.mjs'];
export async function collectionV2RemoteManifestPaths() {
  return [...await collectionV2RefreshManifestPaths(), ...newFiles].sort();
}
async function dbClock(db) {
  const {rows} = await sql`SELECT conditional_collection_clock() AS at`.execute(db);
  return new Date(rows[0].at).toISOString();
}

// Called only for the endpoint selected by discovery after an acknowledged reservation.
// The client owns timeout, validation and rate headers. Retain complete response bytes
// even when its JSON/schema validation fails. Never copy credentials from the environment.
async function requestBytes(endpoint, budget, beforeSend, signal) {
  let bytes = null, status = null, retryMs = null, observationFailed = false;
  const cancelBody = new AbortController();
  const client = new OpenDotaClient({attempts: 1, maxRequests: 1, maxWaitMs: 0, maxResponseBytes: archiveLimits.bodyBytes}, {
    signal,
    budget: {
      async beforeRequest() {
        const permit = await budget.claim();
        if (!permit.allowed) throw new OpenDotaError('source_rate_limited', null, null, permit.retryAfterMs);
        await beforeSend();
      },
      async observe(code, delay, remaining) {
        retryMs = delay;
        try { await budget.observe(code, delay, remaining); }
        catch { observationFailed = true; cancelBody.abort(); throw Error('quota_observation_failed'); }
      }
    },
    async fetch(url, init) {
      assert.equal(url.href, 'https://api.opendota.com/api' + endpoint, 'unexpected_provider_url');
      init.signal.throwIfAborted();
      const bodySignal = AbortSignal.any([init.signal, cancelBody.signal]);
      const response = await fetch(url, {method: 'GET', headers: {Accept: 'application/json'},
        credentials: 'omit', redirect: 'error', signal: bodySignal});
      status = response.status;
      if (!response.ok) return response;
      if (!response.body) {
        bytes = Buffer.alloc(0);
        return response;
      }
      let size = 0;
      const chunks = [];
      const capture = new TransformStream({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > archiveLimits.bodyBytes) throw new OpenDotaError('source_response_too_large', endpoint);
          chunks.push(chunk);
          controller.enqueue(chunk);
        },
        flush() { bytes = Buffer.concat(chunks, size); }
      });
      return new Response(response.body.pipeThrough(capture, {signal: bodySignal}), {status, headers: response.headers});
    }
  });
  let code = null;
  try {
    if (endpoint.startsWith('/leagues/')) await client.getLeagueMatchDiscovery(endpoint.split('/')[2]);
    else if (endpoint.startsWith('/matches/')) await client.getMatchSource(endpoint.split('/')[2]);
    else await client.getProMatchDiscovery(endpoint.split('=')[1]);
  } catch (error) {
    code = signal.aborted ? 'transport_cancelled' : error instanceof OpenDotaError ? error.code : 'transport_guard_failed';
    if (error instanceof OpenDotaError) retryMs ??= error.retryAfterMs;
  }
  return {bytes, status, code, retryMs, observationFailed};
}

// Each command advances at most one endpoint. Replaying its UUID never advances again.
export class RemoteCollectionV2 {
  constructor(db) {
    this.db = db;
    this.journal = new ConditionalCollectionV2Journal(db);
    this.discovery = new ConditionalCollectionV2Discovery(db);
    this.budget = new PostgresProviderBudget(db);
  }
  async step(raw, {signal: callerSignal} = {}) {
    const deadline = AbortSignal.timeout(60000);
    const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    const {ownerId, registrationId, registrationSha256, operationId} = RemoteStepRequest.parse(raw);
    const registration = await this.journal.registration(ownerId, registrationId);
    assert.equal(registration.packageSha256, registrationSha256, 'expected_registration_hash');
    const bundle = JSON.parse(registration.packageText);
    for (const file of newFiles) assert(bundle.executable.code[file], 'remote_adapter_not_registered');
    await verifyCollectionV2RefreshManifest(registration);
    signal.throwIfAborted();
    return this.db.connection().execute(async connection => {
      const key = 'conditional-runtime-v2:' + registrationId;
      const lock = await sql`SELECT pg_try_advisory_lock(hashtextextended(${key},0)) AS locked`.execute(connection);
      if (!lock.rows[0].locked) return {status: 'busy'};
      try {
        const at = await dbClock(connection);
        const {from, assessmentAt} = registration.plan.window;
        const {rows} = await sql`SELECT synthetic_only, max_bytes, max_responses FROM conditional_blob_archives
          WHERE registration_id=${registrationId}::uuid`.execute(connection);
        assert(!rows[0]?.synthetic_only, 'real_archive_required');
        if (at < from || (!rows[0] && at >= assessmentAt)) return {status: 'collection_window_closed'};
        const state = await this.journal.initialize(ownerId, registrationId, registrationSha256, {
          syntheticOnly: false, maxBytes: Number(rows[0]?.max_bytes ?? archiveLimits.globalBytes),
          maxResponses: rows[0]?.max_responses ?? Math.min(1000, registration.plan.collection.maxHttpAttempts)
        });
        return await this.#advance({ownerId, registrationId, operationId}, registration, state, signal);
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${key},0))`.execute(connection);
      }
    });
  }
  async #advance({ownerId, registrationId, operationId}, registration, state, signal) {
    const journal = this.journal;
    const finish = (head, command) => journal.append(ownerId, registrationId, head, randomUUID(), command);
    const archivedCode = async requestId => {
      const {rows} = await sql`SELECT metadata_text::jsonb->>'clientValidationCode' AS code FROM conditional_blob_receipts
        WHERE registration_id=${registrationId}::uuid AND request_id=${requestId}::uuid`.execute(this.db);
      assert.equal(rows.length, 1, 'archive_receipt_missing');
      return rows[0].code;
    };
    if (state.pendingRequest) {
      const requestId = state.pendingRequest.requestId;
      if (requestId !== operationId) return {status: 'resume_required', requestId};
      if (state.archive.pendingReceiptRequestId !== requestId) return {status: 'inflight_outcome_unknown', requestId};
      await finish(state.headSha256, {kind: 'complete', requestId});
      return {status: 'resumed', requestId, validationCode: await archivedCode(requestId)};
    }
    const previous = state.requests.find(row => row.requestId === operationId);
    if (previous) return {status: 'already_recorded', outcome: previous.status, requestId: operationId,
      validationCode: previous.status === 'archived' ? await archivedCode(operationId) : null};
    const {report} = await this.discovery.read(ownerId, registrationId);
    assert.equal(report.syntheticOnly, false, 'real_discovery_required');
    assert.equal(report.journalHeadSha256, state.headSha256, 'discovery_head_changed');
    if (!report.nextRequest) return {status: 'no_next_request', reasons: report.reasons};
    const capacity = await journal.archive.capacity(ownerId, registrationId);
    if (!capacity.canFitMaximumBody) return {status: 'archive_capacity_low'};
    const invalid = await sql`SELECT request_id FROM conditional_blob_receipts WHERE registration_id=${registrationId}::uuid
      AND metadata_text::jsonb->>'clientValidationCode' IS NOT NULL LIMIT 1`.execute(this.db);
    if (invalid.rows.length) return {status: 'invalid_provider_response', requestId: invalid.rows[0].request_id};
    const endpoint = report.nextRequest.endpoint, requestId = operationId;
    const command = CollectionV2Command.parse({kind: 'reserve', requestId, endpoint});
    signal.throwIfAborted();
    const reserved = await journal.append(ownerId, registrationId, state.headSha256, operationId, command);
    if (reserved.operationStatus !== 'recorded') return {status: 'already_recorded', requestId};
    const response = await requestBytes(endpoint, this.budget, async () => {
      const current = await journal.read(ownerId, registrationId);
      const age = Date.parse(current.snapshotAt) - Date.parse(reserved.event.at);
      assert(current.pendingRequest?.requestId === requestId && current.headSha256 === reserved.headSha256
        && age >= 0 && age < 30000 && current.snapshotAt < registration.plan.window.assessmentAt, 'stale_reservation');
      signal.throwIfAborted();
    }, signal);
    // An unobserved quota response leaves the reservation pending. Restart cannot resend.
    if (response.observationFailed) return {status: 'quota_observation_failed', requestId};
    const receivedAt = await dbClock(this.db);
    const hasBody = response.bytes !== null;
    if (hasBody) {
      await journal.archive.saveResponse(ownerId, registrationId, operationId, {
        requestId, endpoint, httpStatus: response.status, receivedAt, clientValidationCode: response.code
      }, response.bytes);
    }
    const retryAfterAt = response.retryMs === null ? null :
      new Date(Math.min(Date.parse(receivedAt) + response.retryMs, 253402300799999)).toISOString();
    const outcome = transportV2Command({requestId, hasBody, httpStatus: response.status, code: response.code, retryAfterAt});
    await finish(reserved.headSha256, outcome);
    return {status: hasBody ? 'archived' : 'attempt_failed', requestId, endpoint, httpStatus: response.status, validationCode: response.code};
  }
}
