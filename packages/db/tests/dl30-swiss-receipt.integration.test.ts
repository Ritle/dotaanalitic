import {readFile} from 'node:fs/promises';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sample} from '../../../tests/fixtures/dl30-swiss-stage.mjs';
import {sha} from '../../../tools/research/exposure-ledger-core.mjs';
import {endpoints, reviewStage} from '../../../tools/research/review-dl30-swiss-stage.mjs';
import {reviewSwissReceipt} from '../../../tools/research/review-dl30-swiss-receipt.mjs';
import {sql} from '../dist/index.js';

const proposalBytes = await readFile(new URL('../../../tools/research/player-hero-dl30-swiss-proposal.json',import.meta.url));
const rehearsalSql = await readFile(new URL('../../../tests/fixtures/dl30-swiss-receipt-rehearsal.sql',import.meta.url),'utf8');
const at = '2026-11-25T10:00:00.000Z';
const packageSha256 = '51183190a4710947b1135167fe52dc1c6eb0f30aca21d1c30a0fc97b53c6bd1f';
let database: Awaited<ReturnType<typeof testDatabase>>;
let owner: string;

function fixture() {
  const bodies = sample();
  const sources = Object.fromEntries(Object.entries(endpoints).map(([key,url]) =>
    [key,{url,fetchedAt:at,sha256:sha(JSON.stringify(bodies[key as keyof typeof bodies]))}]));
  const stage = {...reviewStage(bodies,JSON.parse(proposalBytes.toString()),at),sources,
    proposalSha256:sha(proposalBytes),packageSha256};
  const inventory = {mapIds:['12'],openDotaSeriesIds:['13'],pandaScoreMeetingIds:['13']};
  const report = {reviews:{local:{sha256:sha('local fixture'),capturedAt:at},peer:{sha256:sha('peer fixture'),capturedAt:at}},
    peerDatabaseReportProvided:true,basePackageSha256:packageSha256,unionSha256:sha(JSON.stringify(inventory))};
  return {stage,inventory,report};
}
async function clock(time: string) {
  await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS timestamptz
    LANGUAGE sql VOLATILE AS ${sql.lit("SELECT '" + time + "'::timestamptz")}`.execute(database.db);
}
beforeEach(async () => {
  database = await testDatabase();
  await sql.raw(rehearsalSql).execute(database.db);
  await clock(at);
  owner = (await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role)
    VALUES('swiss-fixture',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
},60000);
afterEach(async () => { await database?.close(); },30000);

function choose() {
  return sql`SELECT * FROM dl30_choose_protocol(${owner}::uuid,'swiss_stage',${sha(proposalBytes)})`.execute(database.db);
}
function prepare(evidence: object,digest = sha(JSON.stringify(evidence)), privateReviewed = true) {
  return sql`INSERT INTO swiss_rehearsal_plans(digest,evidence,owner_id,reviewed_at,private_sources_reconciled)
    VALUES(${digest},${JSON.stringify(evidence)},${owner}::uuid,${at}::timestamptz,${privateReviewed})`;
}
const observe = (digest: string) => sql`SELECT * FROM observe_swiss_rehearsal(${digest})`;

it('records one receipt only after the reviewed plan has committed and protects both records',async () => {
  const f = fixture(), {digest,evidence} = reviewSwissReceipt(f.stage,f);
  await expect(prepare(evidence,digest).execute(database.db)).rejects.toThrow('swiss_owner_choice_required');
  await choose();
  await expect(database.db.transaction().execute(async tx => {
    await prepare(evidence,digest).execute(tx);
    await observe(digest).execute(tx);
  })).rejects.toThrow('commit_unobserved');
  await prepare(evidence,digest).execute(database.db);
  const [first,retry] = await Promise.all([observe(digest).execute(database.db),observe(digest).execute(database.db)]);
  expect(retry.rows).toEqual(first.rows);
  const rows = (await sql<{digest:string,observed_at:Date}>`SELECT * FROM swiss_rehearsal_receipts`.execute(database.db)).rows;
  expect(rows.map(r => [r.digest,r.observed_at.toISOString()])).toEqual([[digest,at]]);
  await clock('2026-12-01T18:00:00.000Z');
  expect((await observe(digest).execute(database.db)).rows).toEqual(first.rows);
  await expect(observe(sha('different')).execute(database.db)).rejects.toThrow('receipt_already_observed');
  for (const query of [sql`UPDATE swiss_rehearsal_plans SET writer_xid=0`,sql`DELETE FROM swiss_rehearsal_receipts`,
    sql`TRUNCATE swiss_rehearsal_receipts`]) await expect(query.execute(database.db)).rejects.toThrow('immutable');
  expect((await sql`SELECT * FROM dl30_registration_receipts`.execute(database.db)).rows).toHaveLength(0);
});

it('rejects missing stage, peer, private-source review and altered evidence',async () => {
  await choose();
  const f = fixture();
  const missing = reviewSwissReceipt({...f.stage,status:'unavailable',binding:null},
    {...f,report:{...f.report,peerDatabaseReportProvided:false}});
  expect(missing).toMatchObject({evidence:null,digest:null,reasons:['STAGE_BINDING_REQUIRED','PEER_REVIEW_REQUIRED']});
  const {evidence,digest} = reviewSwissReceipt(f.stage,f);
  await expect(prepare({...evidence,binding:null}).execute(database.db)).rejects.toThrow('stage_binding_required');
  await expect(prepare({...evidence,reviews:{local:f.report.reviews.local}}).execute(database.db)).rejects.toThrow('pc_review_required');
  await expect(prepare(evidence,sha('other')).execute(database.db)).rejects.toThrow('evidence_changed');
  await expect(prepare({...evidence,inventory:{...f.inventory,mapIds:['12','15']}}).execute(database.db))
    .rejects.toThrow('inventory_digest_mismatch');
  await expect(prepare(evidence,digest,false).execute(database.db)).rejects.toThrow();
  expect((await sql`SELECT * FROM swiss_rehearsal_plans`.execute(database.db)).rows).toHaveLength(0);
});

it('rechecks the inventory and database deadline when observing the committed plan',async () => {
  await choose();
  const f = fixture(), {evidence,digest} = reviewSwissReceipt(f.stage,f);
  await prepare(evidence,digest).execute(database.db);
  await sql`INSERT INTO matches(id,started_at) VALUES(777,${at}::timestamptz)`.execute(database.db);
  await expect(observe(digest).execute(database.db)).rejects.toThrow('dl30_inventory_changed');
  await clock('2026-11-30T18:00:00.000Z');
  await expect(observe(digest).execute(database.db)).rejects.toThrow('swiss_registration_time_invalid');
  expect((await sql`SELECT * FROM swiss_rehearsal_receipts`.execute(database.db)).rows).toHaveLength(0);
});
