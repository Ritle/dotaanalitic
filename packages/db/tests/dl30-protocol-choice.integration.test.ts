import {beforeEach, afterEach, expect, it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {chooseDl30Protocol, readDl30Choice} from '../../../tools/research/dl30-protocol-choice.mjs';

const full = '9f38b8f0af80b905e6fe6d04f0249e320f82dd5fbbd2065141e8288ceb569045';
const swiss = '5d6015e97563ed366f5ec40ec3c941c3896607b29c1e0b0735431bd5be2b55f0';
const at = '2026-11-25T10:00:00.000Z';
let database: Awaited<ReturnType<typeof testDatabase>>;
let owner: string;
async function clock(value: string) {
  await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS timestamptz
    LANGUAGE sql VOLATILE AS ${sql.lit("SELECT '" + value + "'::timestamptz")}`.execute(database.db);
}
beforeEach(async () => {
  database = await testDatabase();
  expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
  await clock(at);
  owner = (await sql<{id: string}>`INSERT INTO app_users(login,password_hash,account_role)
    VALUES('choice-test',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
}, 60000);
afterEach(async () => { await database?.close(); }, 30000);

const chooseSwiss = () => chooseDl30Protocol(database.db, owner, 'swiss_stage', swiss);
function legacyInsert() {
  return sql`INSERT INTO dl30_registrations(owner_user_id,package_text,package_sha256)
    VALUES(${owner}::uuid,'{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`;
}
async function allowFixtureEvidence() {
  // Retain 072's real owner, lock, time and receipt guards in the disposable DB.
  await sql`CREATE OR REPLACE FUNCTION check_dl30_registration(p jsonb, owner_id uuid, at_time timestamptz)
    RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$`.execute(database.db);
}

it('validates the owner, proposal and deadline, and a failed registration never reserves a scope', async () => {
  await expect(legacyInsert().execute(database.db)).rejects.toThrow('dl30_package_changed');
  await expect(chooseDl30Protocol(database.db, owner, 'swiss_stage', full)).rejects.toThrow();
  await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
  await expect(chooseSwiss()).rejects.toThrow('dl30_active_owner_required');
  await sql`UPDATE app_users SET account_role='owner', is_active=false WHERE id=${owner}::uuid`.execute(database.db);
  await expect(chooseSwiss()).rejects.toThrow('dl30_active_owner_required');
  await sql`UPDATE app_users SET is_active=true WHERE id=${owner}::uuid`.execute(database.db);
  await clock('2026-11-30T18:00:00.000Z');
  await expect(chooseSwiss()).rejects.toThrow('dl30_deadline');
  expect(await readDl30Choice(database.db)).toEqual({status:'no_choice'});
});

it('keeps one immutable decision with a server time and accepts identical retries after the deadline', async () => {
  const [first, second] = await Promise.all([chooseSwiss(), chooseSwiss()]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({status:'protocol_chosen', protocol:'swiss_stage', selectedAt:at});
  await clock('2026-12-03T12:00:00.000Z');
  expect(await chooseSwiss()).toEqual(first);
  await expect(chooseDl30Protocol(database.db, owner, 'full_event', full)).rejects.toThrow('dl30_protocol_already_chosen');
  for (const query of [sql`UPDATE dl30_protocol_choice SET selected_at=now()`, sql`DELETE FROM dl30_protocol_choice`,
    sql`TRUNCATE dl30_protocol_choice`]) {
    await expect(query.execute(database.db)).rejects.toThrow('dl30_choice_immutable');
  }
  expect((await sql`SELECT registration_id FROM dl30_registration_receipts`.execute(database.db)).rows).toEqual([]);
});

it.each(['full_event','swiss_stage'])('serializes overlapping transactions when %s acquires the lock first', async winner => {
  await allowFixtureEvidence();
  let loser: Promise<unknown> | undefined;
  await database.db.transaction().execute(async tx => {
    if (winner === 'full_event') await legacyInsert().execute(tx);
    else await sql`SELECT * FROM dl30_choose_protocol(${owner}::uuid,'swiss_stage',${swiss})`.execute(tx);
    const attempt = winner === 'full_event' ? chooseSwiss() : legacyInsert().execute(database.db);
    loser = attempt.then(() => 'unexpected success', (error: Error) => error.message);
    const timeout = Date.now() + 5000;
    for (;;) {
      const {rows} = await sql<{waiting:boolean}>`SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE NOT granted AND locktype='advisory' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS waiting`.execute(tx);
      if (rows[0]!.waiting) break;
      if (Date.now() >= timeout) throw Error('second transaction did not wait for the first');
      await delay(10);
    }
  });
  expect(await loser).toContain('dl30_protocol_already_chosen');
  expect(await readDl30Choice(database.db)).toMatchObject({protocol:winner});
  expect((await sql`SELECT id FROM dl30_registrations`.execute(database.db)).rows).toHaveLength(winner==='full_event' ? 1 : 0);
});

it('rolls back a legacy claim with its transaction', async () => {
  await allowFixtureEvidence();
  await expect(database.db.transaction().execute(async tx => {
    await legacyInsert().execute(tx);
    expect(await readDl30Choice(tx)).toMatchObject({protocol:'full_event'});
    throw Error('fixture rollback');
  })).rejects.toThrow('fixture rollback');
  expect(await chooseSwiss()).toMatchObject({protocol:'swiss_stage'});
});

it('preserves the legacy owner and time when upgrading a database with a pending plan', async () => {
  await allowFixtureEvidence();
  const migration = await readFile(new URL('../migrations/074_dl30_protocol_choice.sql',import.meta.url),'utf8');
  await database.db.transaction().execute(async tx => {
    // Recreate the pre-074 state inside this isolated DB, then run the shipped migration.
    await sql`DROP TRIGGER dl30_registration_choice ON dl30_registrations`.execute(tx);
    await sql`DROP FUNCTION choose_protocol_for_dl30_registration()`.execute(tx);
    await sql`DROP FUNCTION dl30_choose_protocol(uuid,text,text)`.execute(tx);
    await sql`DROP TABLE dl30_protocol_choice`.execute(tx);
    await sql`DROP FUNCTION guard_dl30_protocol_choice()`.execute(tx);
    await legacyInsert().execute(tx);
    await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(tx);
    await sql.raw(migration).execute(tx);
  });
  expect(await readDl30Choice(database.db)).toMatchObject({protocol:'full_event',ownerId:owner,selectedAt:at});
});
