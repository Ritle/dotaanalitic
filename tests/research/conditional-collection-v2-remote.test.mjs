import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {RemoteCollectionV2, RemoteStepRequest} from '../../tools/research/conditional-collection-v2-remote.mjs';
import {verifyCollectionV2RefreshManifest} from '../../tools/research/conditional-collection-v2-refresh.mjs';

// Model the registration, advisory lock and journal. Exercise the actual OpenDota
// client and byte stream, with no connection to either the provider or working DB.
const {query} = vi.hoisted(() => ({query: vi.fn()}));
vi.mock('../../packages/db/dist/index.js', async original => ({
  ...await original(), sql: (parts, ...values) => ({execute: () => query(parts.join('?'), values)})
}));
vi.mock('../../tools/research/conditional-collection-v2-refresh.mjs', async original => ({
  ...await original(), verifyCollectionV2RefreshManifest: vi.fn()
}));

const at = '2026-12-03T12:00:00.000Z';
const hash = 'a'.repeat(64);
let worker, request, registration, state, report, wire, stored, archive, busy;
beforeEach(() => {
  vi.resetAllMocks();
  request = {mode: 'opendota-remote', ownerId: randomUUID(), registrationId: randomUUID(),
    registrationSha256: hash, operationId: randomUUID()};
  registration = {packageSha256: hash, packageText: JSON.stringify({executable: {code: {
    'tools/research/conditional-collection-v2-remote.mjs': hash,
    'tools/research/run-conditional-collection-v2-remote.mjs': hash
  }}}), plan: {collection: {maxHttpAttempts: 1000}, window: {from: '2026-11-20T00:00:00.000Z', assessmentAt: '2026-12-25T00:00:00.000Z'}}};
  state = {requests: [], pendingRequest: null, archive: {}, headSha256: hash};
  report = {syntheticOnly: false, journalHeadSha256: hash, nextRequest: {endpoint: '/proMatches'}, reasons: []};
  archive = []; stored = null; busy = false;
  query.mockImplementation(async sql => {
    if (sql.includes('pg_try_advisory_lock')) return {rows: [{locked: !busy}]};
    if (sql.includes('pg_advisory_unlock')) return {rows: []};
    if (sql.includes('conditional_collection_clock')) return {rows: [{at}]};
    if (sql.includes('FROM conditional_blob_archives')) return {rows: archive};
    if (sql.includes('AS code FROM conditional_blob_receipts')) return {rows: [{code: stored.metadata.clientValidationCode}]};
    if (sql.includes('FROM conditional_blob_receipts')) return {rows: stored?.metadata.clientValidationCode ? [{request_id: stored.metadata.requestId}] : []};
    throw Error('query_rejected');
  });
  worker = new RemoteCollectionV2({connection: () => ({execute: callback => callback({})})});
  worker.budget = {claim: vi.fn(async () => ({allowed: true})), observe: vi.fn()};
  worker.discovery = {read: vi.fn(async () => ({report}))};
  worker.journal = {
    registration: vi.fn(async () => registration), initialize: vi.fn(async () => state),
    archive: {capacity: vi.fn(async () => ({canFitMaximumBody: true})),
      saveResponse: vi.fn(async (_owner, _id, _op, metadata, bytes) => {
        stored = {metadata, bytes}; state.archive.pendingReceiptRequestId = metadata.requestId;
      })},
    read: vi.fn(async () => ({...state, snapshotAt: at})),
    append: vi.fn(async (_owner, _id, _head, _operationId, command) => {
      if (command.kind === 'reserve') {
        state.pendingRequest = command; state.headSha256 = 'b'.repeat(64);
      } else {
        state.requests.push({requestId: command.requestId, status: command.kind === 'complete' ? 'archived' : 'failed'});
        state.pendingRequest = null;
      }
      return {...state, event: {at}, operationStatus: 'recorded'};
    })
  };
  wire = vi.fn(async () => new Response(' []\r\n', {headers: {'x-rate-limit-remaining-minute': '17'}}));
  vi.stubGlobal('fetch', wire);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('uses the discovered HTTPS endpoint once and preserves the exact bytes', async () => {
  vi.stubEnv('OPENDOTA_API_KEY', 'synthetic-do-not-send');
  report.nextRequest.endpoint = '/proMatches?less_than_match_id=21';
  const result = await worker.step(request);
  expect(result.status).toBe('archived');
  const [url, init] = wire.mock.calls[0];
  expect(url.href).toBe('https://api.opendota.com/api/proMatches?less_than_match_id=21');
  expect(init).toMatchObject({method: 'GET', redirect: 'error', credentials: 'omit', headers: {Accept: 'application/json'}});
  expect(JSON.stringify([init.headers, result])).not.toContain('synthetic-do-not-send');
  expect(stored.bytes.toString()).toBe(' []\r\n');
  expect(worker.budget.observe).toHaveBeenCalledWith(200, null, {minute: 17, month: null, day: null});
  expect((await worker.step(request)).status).toBe('already_recorded');
  expect(wire).toHaveBeenCalledTimes(1);
});
it.each(['origin', 'apiKey', 'url', 'endpoint'])('refuses caller-supplied %s', field => {
  expect(RemoteStepRequest.safeParse({...request, [field]: 'example'}).success).toBe(false);
});
it.each(['hash', 'manifest', 'synthetic', 'busy', 'window', 'excluded', 'unregistered', 'tampered'])('blocks %s before dispatch', async reason => {
  if (reason === 'hash') request.registrationSha256 = '0'.repeat(64);
  if (reason === 'manifest') vi.mocked(verifyCollectionV2RefreshManifest).mockRejectedValueOnce(Error('code_changed'));
  if (reason === 'synthetic') archive = [{synthetic_only: true}];
  if (reason === 'busy') busy = true;
  if (reason === 'window') registration.plan.window.from = '2027-01-01T00:00:00.000Z';
  if (reason === 'excluded') report.nextRequest = null;
  if (reason === 'unregistered') worker.journal.registration.mockRejectedValue(Error('registration_missing'));
  if (reason === 'tampered') report.nextRequest.endpoint = 'https://untrusted.invalid';
  await worker.step(request).catch(() => null);
  expect(wire).not.toHaveBeenCalled(); expect(worker.journal.append).not.toHaveBeenCalled();
});
it('recovers saved bytes after interruption without another HTTP request', async () => {
  const append = worker.journal.append.getMockImplementation();
  worker.journal.append.mockImplementationOnce(append).mockRejectedValueOnce(Error('lost_commit'));
  await expect(worker.step(request)).rejects.toThrow('lost_commit');
  expect((await worker.step({...request, operationId: randomUUID()})).status).toBe('resume_required');
  expect((await worker.step(request)).status).toBe('resumed');
  expect(wire).toHaveBeenCalledTimes(1);
});
it('leaves uncertain archive writes pending across retries', async () => {
  worker.journal.archive.saveResponse.mockRejectedValueOnce(Error('unknown_persistence'));
  await expect(worker.step(request)).rejects.toThrow();
  expect((await worker.step(request)).status).toBe('inflight_outcome_unknown');
  expect(wire).toHaveBeenCalledTimes(1);
});
it.each([302, 401, 429, 503])('records HTTP %i without sending again or archiving an error body', async status => {
  wire.mockResolvedValueOnce(new Response('private-error-detail', {status, headers: {
    'retry-after': '60', location: 'https://other.invalid/'
  }}));
  const result = await worker.step(request);
  expect(result).toMatchObject({status: 'attempt_failed', httpStatus: status});
  expect(JSON.stringify(result)).not.toContain('private-error-detail');
  expect(stored).toBeNull(); expect(wire).toHaveBeenCalledTimes(1);
  expect(worker.journal.append.mock.lastCall[4].retryAfterAt).toBe('2026-12-03T12:01:00.000Z');
});
it('fails closed after quota observation fails, including retries', async () => {
  worker.budget.observe.mockRejectedValueOnce(Error('unavailable'));
  expect((await worker.step(request)).status).toBe('quota_observation_failed');
  expect((await worker.step(request)).status).toBe('inflight_outcome_unknown');
  expect(wire).toHaveBeenCalledTimes(1);
});
it('refuses denied quota before HTTP', async () => {
  worker.budget.claim.mockResolvedValueOnce({allowed: false, retryAfterMs: 60000});
  expect((await worker.step(request)).status).toBe('attempt_failed');
  expect(wire).not.toHaveBeenCalled();
});
it('archives invalid UTF-8 unchanged and stops the next step', async () => {
  wire.mockResolvedValueOnce(new Response(Uint8Array.of(255)));
  expect((await worker.step(request)).validationCode).toBe('source_invalid_json');
  expect(stored.bytes).toEqual(Buffer.from([255]));
  expect(await worker.step(request)).toMatchObject({status: 'already_recorded', validationCode: 'source_invalid_json'});
  report.journalHeadSha256 = state.headSha256;
  expect((await worker.step({...request, operationId: randomUUID()})).status).toBe('invalid_provider_response');
  expect(wire).toHaveBeenCalledTimes(1);
});
it('discards oversized responses without archiving a prefix', async () => {
  wire.mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
  expect((await worker.step(request)).validationCode).toBe('source_response_too_large');
  expect(stored).toBeNull();
});
