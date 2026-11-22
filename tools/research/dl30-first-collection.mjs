import assert from 'node:assert/strict';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {OpenDotaClient, OpenDotaError} from '../../packages/ingestion/dist/opendota/client.js';
import {PostgresProviderBudget} from '../../packages/ingestion/dist/quota.js';
import {archiveLimits} from './conditional-blob-archive.mjs';
import {inspectDl30Collection} from './inspect-dl30-collection.mjs';

const Request = z.object({
  registrationSha256: z.string().regex(/^[0-9a-f]{64}$/),
  operationId: z.string().uuid().transform(value => value.toLowerCase())
}).strict();

async function retained(db, registrationSha256, operationId) {
  const {rows: [row]} = await sql`SELECT q.operation_id, q.endpoint, r.observed_at, r.http_status,
      r.result_code, r.body_sha256, octet_length(r.body) AS body_bytes
    FROM dl30_first_requests q LEFT JOIN dl30_first_responses r USING (operation_id)
    JOIN app_users u ON u.id=q.owner_user_id AND u.is_active AND u.account_role='owner'
    WHERE q.registration_sha256=${registrationSha256}`.execute(db);
  if (!row) return null;
  if (row.operation_id !== operationId) return {status: 'operation_already_reserved', operationId: row.operation_id};
  if (!row.observed_at) return {status: 'inflight_outcome_unknown', operationId};
  return {
    status: row.body_sha256 ? 'archived' : 'attempt_failed', operationId, endpoint: row.endpoint,
    observedAt: row.observed_at.toISOString(), httpStatus: row.http_status, validationCode: row.result_code,
    bodySha256: row.body_sha256, bodyBytes: row.body_bytes
  };
}

async function captureLeague(db, {operationId, endpoint, leagueId}, fetchProvider, signal) {
  const budget = new PostgresProviderBudget(db);
  let httpStatus = null, body = null, failure = null;
  const client = new OpenDotaClient({attempts: 1, maxRequests: 1, maxWaitMs: 0, maxResponseBytes: archiveLimits.bodyBytes}, {
    signal,
    budget: {
      async beforeRequest() {
        const permit = await budget.claim();
        if (!permit.allowed) throw new OpenDotaError('source_rate_limited', null, null, permit.retryAfterMs);
        const {rows: [row]} = await sql`SELECT dl30_first_request_in_window(${operationId}::uuid) AS allowed`.execute(db);
        if (!row.allowed) {
          failure = 'collection_window_or_reservation_closed';
          throw Error(failure);
        }
      },
      async observe(status, delay, remaining) {
        try {
          await budget.observe(status, delay, remaining);
        } catch {
          failure = 'quota_observation_failed';
          throw Error(failure);
        }
      }
    },
    async fetch(url, init) {
      assert.equal(url.href, 'https://api.opendota.com/api' + endpoint, 'unexpected_provider_url');
      init.signal.throwIfAborted();
      const response = await fetchProvider(url, {...init, credentials: 'omit'});
      httpStatus = response.status;
      if (!response.ok) return response;
      if (!response.body) {
        body = Buffer.alloc(0);
        return response;
      }
      const chunks = [];
      let size = 0;
      const capture = new TransformStream({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > archiveLimits.bodyBytes) throw new OpenDotaError('source_response_too_large', endpoint);
          chunks.push(chunk);
          controller.enqueue(chunk);
        },
        flush() { body = Buffer.concat(chunks, size); }
      });
      return new Response(response.body.pipeThrough(capture, {signal: init.signal}), {
        status: response.status, headers: response.headers
      });
    }
  });
  try {
    await client.getLeagueMatchDiscovery(leagueId);
  } catch (error) {
    failure ??= signal.aborted ? 'transport_cancelled' : error instanceof OpenDotaError ? error.code : 'transport_guard_failed';
  }
  return {httpStatus, body, failure};
}

export async function collectDl30FirstLeague(db, raw, {fetchProvider = globalThis.fetch, signal: callerSignal} = {}) {
  const {registrationSha256, operationId} = Request.parse(raw);
  const preview = await inspectDl30Collection(db);
  if (preview.registrationSha256 !== registrationSha256 || !preview.registeredAt) return {status: 'registration_receipt_required'};
  const prior = await retained(db, registrationSha256, operationId);
  if (prior) return prior;
  if (preview.phase !== 'target_window') return {status: 'collection_window_closed', phase: preview.phase};

  const endpoint = preview.firstLeagueEndpoint;
  const deadline = AbortSignal.timeout(30000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  signal.throwIfAborted();
  const reserved = await db.transaction().execute(async tx => {
    await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
    return sql`INSERT INTO dl30_first_requests(registration_id,operation_id,registration_sha256,owner_user_id,endpoint)
      SELECT id,${operationId}::uuid,package_sha256,owner_user_id,${endpoint}
      FROM dl30_registrations WHERE package_sha256=${registrationSha256}
      ON CONFLICT (registration_id) DO NOTHING RETURNING operation_id`.execute(tx);
  });
  if (!reserved.rows.length) return retained(db, registrationSha256, operationId);

  const {httpStatus, body, failure} = await captureLeague(db, {operationId, endpoint, leagueId: preview.leagueId}, fetchProvider, signal);
  await db.transaction().execute(async tx => {
    await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
    await sql`INSERT INTO dl30_first_responses(operation_id,http_status,result_code,body)
      VALUES(${operationId}::uuid,${httpStatus},${failure},${body})`.execute(tx);
  });
  return retained(db, registrationSha256, operationId);
}
