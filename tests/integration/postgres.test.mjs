import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL must be set; refusing to silently skip PostgreSQL integration tests');
const testName = 'codex_bootstrap_' + randomBytes(6).toString('hex');
assert.match(testName, /^codex_bootstrap_[a-f0-9]{12}$/);
const testUrl = new URL(adminUrl);
testUrl.pathname = '/' + testName;
const connectionString = testUrl.toString();
const admin = new pg.Client({ connectionString: adminUrl });
let created = false;
function migrate() {
 return execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/migrate.mjs', import.meta.url))], {
  env: { ...process.env, DATABASE_URL: connectionString }, encoding: 'utf8', timeout: 30000, stdio: 'pipe'
 });
}
before(async () => {
 await admin.connect();
 await admin.query(`CREATE DATABASE "${testName}"`);
 created = true;
 migrate();
}, { timeout: 60000 });
after(async () => {
 try { if (created) await admin.query(`DROP DATABASE "${testName}" WITH (FORCE)`); }
 finally { await admin.end(); }
}, { timeout: 30000 });

test('all current migrations applied with authoritative checksums and idempotent replay', async () => {
 const client=new pg.Client({connectionString});
 await client.connect();
 try{
  const migrationsDir = new URL('../../packages/db/migrations/', import.meta.url);
  const files = (await readdir(migrationsDir)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
  assert.ok(files.length >= 5);
  assert.deepEqual(files.map(name => Number(name.slice(0, 3))), files.map((_, index) => index + 1));
  const {rows}=await client.query('SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename');
  assert.deepEqual(rows.map(x=>x.filename),files);
  const golden = JSON.parse(await readFile(new URL('../golden/migrations-v6.sha256.json', import.meta.url), 'utf8'));
  for (const [filename, checksum] of Object.entries(golden)) {
   assert.equal(rows.find(row => row.filename === filename)?.checksum, checksum, filename);
  }
  for(const {filename,checksum} of rows) {
    const sql=await readFile(new globalThis.URL(`../../packages/db/migrations/${filename}`,import.meta.url));
    assert.equal(checksum,createHash('sha256').update(sql).digest('hex'),filename);
  }
  migrate();
  assert.deepEqual((await client.query('SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename')).rows, rows);
  const {rows: objects}=await client.query(`SELECT
     to_regclass('public.matches')::text AS matches,
     to_regclass('public.match_players')::text AS players,
     to_regclass('public.training_dataset_versions')::text AS datasets,
     to_regclass('public.prediction_runs')::text AS predictions,
     to_regclass('public.match_quality_assessments')::text AS quality,
     to_regclass('public.match_draft_source_observations')::text AS draft_raw,
     to_regclass('public.upcoming_source_cache')::text AS schedule_cache,
     to_regclass('public.pandascore_request_quota')::text AS schedule_quota,
     to_regclass('public.history_refresh_runs')::text AS history_refresh,
     to_regclass('public.ranked_context_receipts')::text AS ranked_receipts,
     to_regclass('public.ranked_context_map_cache')::text AS ranked_cache,
     to_regclass('public.ranked_context_leases')::text AS ranked_leases`);
  assert.ok(Object.values(objects[0]).every(Boolean), 'Critical tables missing');
 }finally{await client.end()}
});

test('terminal training dataset cannot be rewritten',async()=>{
 const client=new pg.Client({connectionString});
 await client.connect();
 try{
  await client.query('BEGIN');
  const q=`INSERT INTO training_dataset_versions (
   stage,status,feature_schema_version,label_policy_version,cutoff_policy_version,
   patch_registry_revision,data_revision,code_revision,split_policy,dataset_fingerprint,frozen_at
  ) VALUES ('pre_match','building','v1','verified-map-v1','v1','p1','data1','code1','{}'::jsonb,NULL,NULL) RETURNING id`;
  const result=await client.query(q);
  const id=result.rows[0].id;
  await client.query('SAVEPOINT empty_freeze');
  await assert.rejects(client.query("UPDATE training_dataset_versions SET status='frozen' WHERE id=$1",[id]),/empty/i);
  await client.query('ROLLBACK TO SAVEPOINT empty_freeze');
  await client.query("UPDATE training_dataset_versions SET status='rejected' WHERE id=$1",[id]);
  await client.query('SAVEPOINT frozen_guard');
  await assert.rejects(client.query('UPDATE training_dataset_versions SET status=$1 WHERE id=$2',['rejected',id]),/Frozen training dataset|immutable/i);
  await client.query('ROLLBACK TO SAVEPOINT frozen_guard');
  await client.query('SAVEPOINT frozen_delete');
  await assert.rejects(client.query('DELETE FROM training_dataset_versions WHERE id=$1',[id]),/Frozen training dataset|immutable/i);
  await client.query('ROLLBACK TO SAVEPOINT frozen_delete');
 }finally{
  await client.query('ROLLBACK').catch(()=>{});
  await client.end();
 }
});

test('map slots, canonical identities and BIGINT values retain database guarantees',async()=>{
 const client=new pg.Client({connectionString});
 await client.connect();
 try {
  await client.query('BEGIN');
  const playerId='9007199254740993';
  await client.query("INSERT INTO players(id,nickname) VALUES ($1,'synthetic-bootstrap')",[playerId]);
  await client.query("INSERT INTO heroes(id,internal_name,localized_name) VALUES (2000000001,'synthetic-bootstrap','synthetic-bootstrap')");
  await client.query("INSERT INTO matches(id,started_at) VALUES (999999999002,NOW())");
  const insert="INSERT INTO match_players(match_id,player_slot,side,player_id,hero_id) VALUES (999999999002,$1,$2,$3,2000000001)";
  await client.query(insert,[0,'radiant',playerId]);
  const {rows}=await client.query('SELECT player_id FROM match_players WHERE match_id=999999999002');
  assert.equal(rows[0].player_id,playerId);
  const {rows: maps}=await client.query('SELECT is_pro,radiant_win FROM matches WHERE id=999999999002');
  assert.deepEqual(maps[0],{is_pro:null,radiant_win:null});
  for(const [slot,side,player,code] of [
   [0,'radiant',null,'23505'], // duplicate map slot
   [128,'dire',playerId,'23505'], // same identity on both sides
   [1,'dire',null,'23514'], // side must agree with native slot
   [5,'radiant',null,'23514'] // slot outside the allowed ranges
  ]) {
   await client.query('SAVEPOINT invalid_slot');
   await assert.rejects(client.query(insert,[slot,side,player]),{code});
   await client.query('ROLLBACK TO SAVEPOINT invalid_slot');
  }
 } finally {
  await client.query('ROLLBACK').catch(()=>{});
  await client.end();
 }
});


test('raw draft and quality records preserve anomalous provider observations (append-only)',async()=>{
 const client=new pg.Client({connectionString});
 await client.connect();
 try {
  await client.query('BEGIN');
  // No team metadata is required for source observations; unknown organization IDs stay NULL.
  await client.query(`INSERT INTO matches(id,started_at,radiant_win,is_pro,source)
     VALUES (999999999001, NOW(), TRUE, TRUE, 'opendota')`);
  const observation=await client.query(`INSERT INTO match_draft_source_observations
    (match_id,provider,adapter_version,fetched_at,raw_picks_bans,payload_sha256)
    VALUES (999999999001,'opendota','synthetic-v9',NOW(),$1::jsonb,$2)
    RETURNING id`,[
     JSON.stringify([{order:0,team:1,hero_id:31,is_pick:true},{order:1,team:1,hero_id:107,is_pick:true}]),
     'a'.repeat(64)
    ]);
  const draftId=observation.rows[0].id;
  await client.query('INSERT INTO matches(id,started_at) VALUES (999999999003,NOW())');
  await client.query('SAVEPOINT cross_map_guard');
  await assert.rejects(client.query(`INSERT INTO match_quality_assessments
    (match_id,draft_observation_id,validator_version)
    VALUES (999999999003,$1,'synthetic-v9')`,[draftId]),{code:'23503'});
  await client.query('ROLLBACK TO SAVEPOINT cross_map_guard');
  await client.query(`INSERT INTO match_quality_assessments
    (match_id,draft_observation_id,validator_version,organization_status,series_status,
     final_heroes_status,draft_timeline_status,draft_order_valid,anomalies)
    VALUES (999999999001,$1,'synthetic-v9','ineligible','ineligible',
     'eligible','structurally_inconsistent',NULL,$2::jsonb)`,
    [draftId,JSON.stringify(['PICK_COUNT_EXTRA','TEAM_ID_MISSING'])]);
  const values=await client.query('SELECT raw_picks_bans FROM match_draft_source_observations WHERE id=$1',[draftId]);
  assert.equal(values.rows[0].raw_picks_bans.length,2);
  await client.query('SAVEPOINT immutable_test');
  await assert.rejects(client.query('DELETE FROM match_draft_source_observations WHERE id=$1',[draftId]),/Immutable draft source/i);
  await client.query('ROLLBACK TO SAVEPOINT immutable_test');
  await client.query('SAVEPOINT quality_guard');
  await assert.rejects(client.query('UPDATE match_quality_assessments SET draft_timeline_status=$1 WHERE draft_observation_id=$2',['verified',draftId]),/Immutable draft source/i);
  await client.query('ROLLBACK TO SAVEPOINT quality_guard');
 } finally {
  await client.query('ROLLBACK').catch(()=>{});
  await client.end();
 }
});
