import {beforeAll, afterAll, it, expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {realSha} from '../../../tools/research/conditional-real-registration.mjs';
import {buildDl30Package, registerDl30} from '../../../tools/research/register-dl30.mjs';
import {inspectDl30Collection} from '../../../tools/research/inspect-dl30-collection.mjs';
import {ConditionalCollectionV2Journal} from '../../../tools/research/conditional-collection-v2-journal.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';

let database: Awaited<ReturnType<typeof testDatabase>>;
let p: Awaited<ReturnType<typeof buildDl30Package>>;
let owner: string;
const at = '2026-11-25T12:00:00.000Z';
async function clock(time: string) {
  expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
  await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS timestamptz
    LANGUAGE sql VOLATILE AS ${sql.lit("SELECT '" + time + "'::timestamptz")}`.execute(database.db);
}
beforeAll(async () => {
  database = await testDatabase();
  owner = (await sql<{id: string}>`INSERT INTO app_users(login,password_hash,account_role)
    VALUES('test-dl30-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
  const previous = await registrationV2Fixture(owner);
  const review = {...previous.review, format: 'dl30-tournament-review-v1',
    reviewedAt: '2026-11-24T12:00:00.000Z', policySha256: '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045',
    bindings: previous.review.bindings.filter(b => b.editionKey === 'DreamLeague Season 30')};
  const floor = JSON.parse(await readFile('.tools/s304-dl30-exposure-ids-r2.json','utf8'));
  p = await buildDl30Package(review,floor);
  await clock(at);
}, 60000);
afterAll(async () => { await database?.close(); }, 30000);

function insert(value: typeof p, id = randomUUID()) {
  const text = JSON.stringify(value);
  return sql`INSERT INTO dl30_registrations(id,owner_user_id,package_text,package_sha256,recorded_at,writer_txid)
    VALUES(${id}::uuid,${owner}::uuid,${text},${realSha(text)},'2000-01-01',1)`;
}
it('rejects an absent main edition, a qualifier, an unrelated organizer link and a changed prepared package', async () => {
  expect(await inspectDl30Collection(database.db)).toMatchObject({
    phase:'awaiting_registration', leagueId:null, registrationSha256:null, firstLeagueEndpoint:null
  });
  const missing = structuredClone(p);
  missing.review.bindings = [];
  await expect((await insert(missing)).execute(database.db)).rejects.toThrow('dl30_review_invalid');
  const qualifier = structuredClone(p);
  qualifier.review.bindings[0].leagueId = '20359';
  await expect((await insert(qualifier)).execute(database.db)).rejects.toThrow('dl30_binding_invalid');
  const link = structuredClone(p);
  link.review.bindings[0].link.href = 'https://www.opendota.com/leagues/20359';
  await expect((await insert(link)).execute(database.db)).rejects.toThrow('dl30_organizer_link_invalid');
  const changed = {...p, preparedText: p.preparedText + ' '};
  await expect((await insert(changed)).execute(database.db)).rejects.toThrow('dl30_package_changed');
});
it('guards the appended floor, new database exclusions, active owner and deadline equality', async () => {
  const removed = structuredClone(p);
  removed.exclusions.mapIds.pop();
  await expect((await insert(removed)).execute(database.db)).rejects.toThrow('dl30_exclusions_invalid');
  await database.db.transaction().execute(async tx => {
    await sql`INSERT INTO matches(id,started_at) VALUES(9999999999999,'2026-11-10')`.execute(tx);
  });
  await expect((await insert(p)).execute(database.db)).rejects.toThrow('dl30_inventory_changed');
  p.exclusions.mapIds.push('9999999999999');
  await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(database.db);
  await expect(inspectDl30Collection(database.db)).rejects.toThrow('one_active_local_owner_required');
  await expect((await insert(p)).execute(database.db)).rejects.toThrow('dl30_active_owner_required');
  await sql`UPDATE app_users SET is_active=true WHERE id=${owner}::uuid`.execute(database.db);
  await clock('2026-11-30T18:00:00.000Z');
  await expect((await insert(p)).execute(database.db)).rejects.toThrow('dl30_deadline');
  await clock(at);
});
it('rejects a same-transaction receipt and uses the server clock for both records', async () => {
  const id = randomUUID();
  await expect(database.db.transaction().execute(async tx => {
    await (await insert(p,id)).execute(tx);
    await sql`INSERT INTO dl30_registration_receipts(registration_id,package_sha256)
      VALUES(${id}::uuid,${realSha(JSON.stringify(p))})`.execute(tx);
  })).rejects.toThrow('dl30_commit_unobserved');
});
it('two submissions return one committed plan, including retry after deadline; a different package is refused', async () => {
  // Simulate a crash after the first commit, followed by an import before the receipt.
  const pendingId = randomUUID();
  await insert(p,pendingId).execute(database.db);
  expect(await inspectDl30Collection(database.db)).toMatchObject({phase:'awaiting_receipt', leagueId:null, firstLeagueEndpoint:null});
  const confirmPending = () => sql`INSERT INTO dl30_registration_receipts(registration_id,package_sha256)
    VALUES(${pendingId}::uuid,${realSha(JSON.stringify(p))})`.execute(database.db);
  await clock('2026-11-30T18:00:00.000Z');
  expect(await inspectDl30Collection(database.db)).toMatchObject({phase:'registration_expired', leagueId:null});
  await expect(confirmPending()).rejects.toThrow('dl30_deadline');
  await clock(at);
  await sql`INSERT INTO matches(id,started_at) VALUES(9999999999998,'2026-11-10')`.execute(database.db);
  await expect(confirmPending()).rejects.toThrow('dl30_inventory_changed');
  p = structuredClone(p);
  p.exclusions.mapIds.push('9999999999998');
  p.review.reviewedAt = '2026-11-25T10:30:00.000Z';
  const text = JSON.stringify(p), digest = realSha(text);
  const submit = () => registerDl30(database.db,owner,text,digest);
  const [a,b] = await Promise.all([submit(),submit()]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({registeredAt: at, status:'registered_plan_only', collectionAllowed:false, evaluationAllowed:false, activationAllowed:false});
  const row = (await sql<{recorded_at: Date; separate: boolean}>`SELECT recorded_at, writer_txid<>observer_txid AS separate
    FROM dl30_registrations JOIN dl30_registration_receipts ON id=registration_id`.execute(database.db)).rows;
  expect(row).toHaveLength(1);
  expect(row[0]!.separate).toBe(true);
  expect(row[0]!.recorded_at.toISOString()).toBe(at);
  const league = p.review.bindings[0].leagueId;
  expect(await inspectDl30Collection(database.db)).toMatchObject({
    phase:'before_window', registeredAt:at, leagueId:league, registrationSha256:digest, firstLeagueEndpoint:null
  });
  await clock('2026-12-01T00:00:00.000Z');
  expect(await inspectDl30Collection(database.db)).toMatchObject({
    phase:'target_window', firstLeagueEndpoint:'/leagues/'+league+'/matches',
    collectionAllowed:false, evaluationAllowed:false, activationAllowed:false
  });
  expect(await submit()).toEqual(a);
  await expect(new ConditionalCollectionV2Journal(database.db).registration(owner, a.id))
    .rejects.toThrow('real_registration_not_found');
  await expect(registerDl30(database.db,owner,text+' ',realSha(text+' '))).rejects.toThrow('registration_already_bound');
  await expect(sql`DELETE FROM dl30_registration_receipts`.execute(database.db)).rejects.toThrow('dl30_registration_immutable');
  await expect(sql`TRUNCATE dl30_registration_receipts`.execute(database.db)).rejects.toThrow('dl30_registration_immutable');
  expect((await sql`SELECT id FROM conditional_real_registrations`.execute(database.db)).rows).toHaveLength(0);
  await clock('2026-12-29T00:00:00.000Z');
  expect(await inspectDl30Collection(database.db)).toMatchObject({phase:'outcome_grace', firstLeagueEndpoint:null});
  await clock('2027-01-05T00:00:00.000Z');
  expect(await inspectDl30Collection(database.db)).toMatchObject({phase:'assessment_date_reached', evaluationAllowed:false, firstLeagueEndpoint:null});
}, 90000);
