import {afterEach, beforeEach, expect, it} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {collectDl30FirstLeague} from '../../../tools/research/dl30-first-collection.mjs';
import {sql} from '../dist/index.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let registrationId: string;
let request: {registrationSha256: string; operationId: string};
const registrationTime = '2026-11-25T12:00:00.000Z';
const windowStart = '2026-12-01T00:00:00.000Z';
const windowEnd = '2026-12-29T00:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function clock(at: string) {
  await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS timestamptz
    LANGUAGE sql VOLATILE AS ${sql.lit('SELECT ' + "'" + at + "'::timestamptz")}`.execute(database.db);
}

beforeEach(async () => {
  database = await testDatabase();
  expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
  await clock(registrationTime);
  // The transport fixture does not require the private frozen H2 input bundle.
  // Keep the registration/receipt clocks and triggers, replace only owner evidence validation.
  await sql`CREATE OR REPLACE FUNCTION check_dl30_registration(p jsonb, owner_id uuid, at_time timestamptz)
    RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$`.execute(database.db);
  const {rows: [owner]} = await sql<{id: string}>`INSERT INTO app_users(login,password_hash,account_role)
    VALUES('synthetic-dl30-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db);
  const text = JSON.stringify({preparedText: JSON.stringify({scope: {fromInclusive: windowStart, untilExclusive: windowEnd}}),
    review: {bindings: [{leagueId: '99999'}]}});
  registrationId = randomUUID();
  request = {registrationSha256: hash(text), operationId: randomUUID()};
  await sql`INSERT INTO dl30_registrations(id,owner_user_id,package_text,package_sha256)
    VALUES(${registrationId}::uuid,${owner!.id}::uuid,${text},${request.registrationSha256})`.execute(database.db);
}, 60000);

afterEach(async () => { await database?.close(); }, 30000);

async function confirm() {
  await sql`INSERT INTO dl30_registration_receipts(registration_id,package_sha256)
    VALUES(${registrationId}::uuid,${request.registrationSha256})`.execute(database.db);
}

it('requires a committed receipt and the correct window before reserving and claiming quota', async () => {
  let sent = 0;
  const run = (input = request) => collectDl30FirstLeague(database.db, input, {
    fetchProvider: async () => { sent++; throw Error('unexpected_http'); }
  });
  expect(await run()).toEqual({status:'registration_receipt_required'});
  await confirm();
  expect(await run({...request, registrationSha256: '0'.repeat(64)})).toEqual({status:'registration_receipt_required'});
  expect(await run()).toEqual({status:'collection_window_closed', phase:'before_window'});
  await clock(windowStart);
  await expect(sql`INSERT INTO dl30_first_requests(registration_id,operation_id,registration_sha256,owner_user_id,endpoint)
    SELECT id,${request.operationId}::uuid,package_sha256,owner_user_id,'/leagues/20359/matches'
    FROM dl30_registrations`.execute(database.db)).rejects.toThrow('dl30_collection_receipt_required');
  await clock(windowEnd);
  expect(await run()).toEqual({status:'collection_window_closed', phase:'outcome_grace'});
  expect(sent).toBe(0);
  const {rows} = await sql`SELECT (SELECT count(*)::int FROM provider_quotas) AS quotas,
    (SELECT count(*)::int FROM dl30_first_requests) AS requests`.execute(database.db);
  expect(rows[0]).toEqual({quotas: 0, requests: 0});
});

it('commits a reservation and one shared quota permit before fetching and replays the archive after the window', async () => {
  await confirm();
  await clock(windowStart);
  const body = ' [ ]\n';
  let sent = 0;
  const run = (input = request) => collectDl30FirstLeague(database.db, input, {
    fetchProvider: async (url: URL, init: RequestInit) => {
      sent++;
      expect(url.href).toBe('https://api.opendota.com/api/leagues/99999/matches');
      expect(init).toMatchObject({method:'GET', redirect:'error', credentials:'omit'});
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      const {rows} = await sql`SELECT (SELECT day_used FROM provider_quotas WHERE provider='opendota') AS used,
        (SELECT count(*)::int FROM dl30_first_requests) AS requests`.execute(database.db);
      expect(rows[0]).toEqual({used:1, requests:1});
      expect(await run()).toMatchObject({status:'inflight_outcome_unknown'});
      return new Response(body);
    }
  });
  const receipt = await run();
  expect(receipt).toEqual({status:'archived', operationId:request.operationId, endpoint:'/leagues/99999/matches',
    observedAt:windowStart, httpStatus:200, validationCode:null, bodySha256:hash(body), bodyBytes:Buffer.byteLength(body)});
  const {rows} = await sql<{body: Buffer}>`SELECT body FROM dl30_first_responses`.execute(database.db);
  expect(rows[0]!.body.toString()).toBe(body);
  await clock(windowEnd);
  expect(await run()).toEqual(receipt);
  expect(await run({...request, operationId:randomUUID()})).toEqual({status:'operation_already_reserved',operationId:request.operationId});
  expect(sent).toBe(1);
  await expect(sql`DELETE FROM dl30_first_responses`.execute(database.db)).rejects.toThrow('dl30_collection_immutable');
  await expect(sql`TRUNCATE dl30_first_requests CASCADE`.execute(database.db)).rejects.toThrow('dl30_collection_immutable');
});

it('keeps an interrupted reservation and prevents another request when the response commit failed', async () => {
  await confirm();
  await clock(windowStart);
  await sql`CREATE FUNCTION fixture_reject_response() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture_response_commit_failed'; END; $$`.execute(database.db);
  await sql`CREATE TRIGGER fixture_reject_response BEFORE INSERT ON dl30_first_responses
    FOR EACH ROW EXECUTE FUNCTION fixture_reject_response()`.execute(database.db);
  let sent = 0;
  const run = (input = request) => collectDl30FirstLeague(database.db, input, {
    fetchProvider: async () => { sent++; return new Response('[]'); }
  });
  await expect(run()).rejects.toThrow('fixture_response_commit_failed');
  await sql`DROP TRIGGER fixture_reject_response ON dl30_first_responses`.execute(database.db);
  expect(await run()).toEqual({status:'inflight_outcome_unknown',operationId:request.operationId});
  expect(await run({...request, operationId:randomUUID()})).toMatchObject({status:'operation_already_reserved'});
  expect(sent).toBe(1);
});

it('records HTTP 429 once and applies Retry-After to the shared quota', async () => {
  await confirm();
  await clock(windowStart);
  const result = await collectDl30FirstLeague(database.db, request, {
    fetchProvider: async () => new Response('busy', {status:429, headers:{'Retry-After':'90'}})
  });
  expect(result).toMatchObject({status:'attempt_failed', httpStatus:429, validationCode:'source_rate_limited', bodySha256:null});
  const {rows} = await sql`SELECT day_used, blocked_until>clock_timestamp()+interval '70 sec' AS cooldown
    FROM provider_quotas WHERE provider='opendota'`.execute(database.db);
  expect(rows[0]).toEqual({day_used:1,cooldown:true});
});

it('retains exact bytes with a validation error for a malformed HTTP success', async () => {
  await confirm();
  await clock(windowStart);
  const body = '{broken';
  const result = await collectDl30FirstLeague(database.db, request, {
    fetchProvider: async () => new Response(body, {status:200})
  });
  expect(result).toMatchObject({status:'archived', httpStatus:200, validationCode:'source_invalid_json', bodySha256:hash(body)});
});
