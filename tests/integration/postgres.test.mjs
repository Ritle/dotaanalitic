import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const URL = process.env.DATABASE_URL;
if (!URL) throw new Error('DATABASE_URL must be set; refusing to silently skip PostgreSQL integration tests');

test('all baseline migrations applied with authoritative checksums', async () => {
 const client=new pg.Client({connectionString:URL});
 await client.connect();
 try{
  const {rows}=await client.query('SELECT filename, checksum FROM schema_migrations ORDER BY filename');
  assert.equal(rows.length,6);
  assert.deepEqual(rows.map(x=>x.filename),[
   '001_initial.sql','002_patch_awareness.sql','003_roster_continuity.sql',
   '004_context_identity_provenance.sql','005_training_pipeline.sql',
   '006_draft_data_quality.sql'
  ]);
  for(const {checksum} of rows)assert.match(checksum,/^[a-f0-9]{64}$/);
  const {rows: objects}=await client.query(`SELECT
     to_regclass('public.matches')::text AS matches,
     to_regclass('public.match_players')::text AS players,
     to_regclass('public.training_dataset_versions')::text AS datasets,
     to_regclass('public.prediction_runs')::text AS predictions,
     to_regclass('public.match_quality_assessments')::text AS quality,
     to_regclass('public.match_draft_source_observations')::text AS draft_raw`);
  assert.ok(Object.values(objects[0]).every(Boolean), 'Critical tables missing');
 }finally{await client.end()}
});

test('frozen training dataset cannot be rewritten',async()=>{
 const client=new pg.Client({connectionString:URL});
 await client.connect();
 try{
  await client.query('BEGIN');
  const q=`INSERT INTO training_dataset_versions (
   stage,status,feature_schema_version,label_policy_version,cutoff_policy_version,
   patch_registry_revision,data_revision,code_revision,split_policy,dataset_fingerprint,frozen_at
  ) VALUES ('pre_match','frozen','v1','v1','v1','p1','data1','code1','{}'::jsonb,$1,NOW()) RETURNING id`;
  const crypto=await import('node:crypto');
  const digest=crypto.randomBytes(32).toString('hex');
  const result=await client.query(q,[digest]);
  const id=result.rows[0].id;
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


test('raw draft and quality records preserve anomalous provider observations (append-only)',async()=>{
 const client=new pg.Client({connectionString:URL});
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
