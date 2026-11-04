import {test,expect,beforeAll,afterAll} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '@dota/db';
import {createHistoryQueue,enqueueHistoryRefresh} from '@dota/ingestion';
import {AuthService} from '../src/modules/auth/service.js';
import {runLocalRestoreDrill} from '../../../scripts/lib/local-restore-drill.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,jobId:string,sourceFingerprint:unknown;
const pgBin=process.env.PG_BIN||fileURLToPath(new URL('../../../.tools/pgsql/bin/',import.meta.url));
async function queueFingerprint(db:typeof database.db){return (await sql`SELECT
 (SELECT md5(string_agg(to_jsonb(j)::text,'' ORDER BY id)) FROM pgboss.job j) jobs,
 (SELECT md5(string_agg(to_jsonb(r)::text,'' ORDER BY id)) FROM history_refresh_runs r) runs`.execute(db)).rows[0];}
async function restoreTargets(){return (await sql`SELECT datname FROM pg_database WHERE datname LIKE 'codex_restore_%' ORDER BY datname`.execute(database.db)).rows;}
beforeAll(async()=>{
 database=await testDatabase();
 const password=randomBytes(24).toString('base64url'),owner=(await new AuthService(database.db).provision('synthetic-queue-restore',password)).id;
 await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES(321,'Synthetic queue restore team',999001)`.execute(database.db);
 // A real pg-boss schema/partitioned job, but no worker or provider is started.
 const boss=await createHistoryQueue(database.url);
 try{jobId=(await enqueueHistoryRefresh(boss,database.db,owner,'321'))!;}
 finally{await boss.stop({graceful:true,timeout:10000});}
 await sql`CREATE SCHEMA pgapplication`.execute(database.db);
 await sql`CREATE TABLE pgapplication.synthetic_probe(id bigint PRIMARY KEY,value text NOT NULL)`.execute(database.db);
 await sql`INSERT INTO pgapplication.synthetic_probe VALUES(9007199254740993,'Synthetic user schema, not PostgreSQL system data')`.execute(database.db);
 sourceFingerprint=await queueFingerprint(database.db);
},30000);
afterAll(async()=>{await database?.close();},30000);
test('includes pg-boss and other pg-prefix user schemas while preserving queued payload, run link and source',async()=>{
 const before=await restoreTargets();
 const result=await runLocalRestoreDrill({databaseUrl:database.url,pgBin},async(db:typeof database.db)=>{
  expect(await queueFingerprint(db)).toEqual(sourceFingerprint);
  const job=(await sql`SELECT id::text,state,data,started_on,retry_count FROM pgboss.job WHERE id=${jobId}::uuid`.execute(db)).rows[0];
  expect(job).toMatchObject({id:jobId,state:'created',data:{runId:jobId},started_on:null,retry_count:0});
  expect((await sql`SELECT status,attempt,processed FROM history_refresh_runs WHERE id=${jobId}::uuid`.execute(db)).rows[0]).toEqual({status:'queued',attempt:0,processed:0});
  expect((await sql`SELECT id::text FROM pgapplication.synthetic_probe`.execute(db)).rows[0]?.id).toBe('9007199254740993');
 });
 const manifest=JSON.parse(await readFile(fileURLToPath(new URL('../../../'+result.directory+'/backup.json',import.meta.url)),'utf8'));
 const entries=manifest.tables as {schema:string;table:string;n:string}[];
 expect(entries.some(t=>t.schema==='pgboss'&&t.table==='job'&&t.n==='1')).toBe(true);
 expect(entries.some(t=>t.schema==='pgboss'&&t.table==='job_common'&&t.n==='1')).toBe(true);
 expect(entries.some(t=>t.schema==='pgapplication'&&t.table==='synthetic_probe')).toBe(true);
 expect(entries.some(t=>t.schema.startsWith('pg_')||t.schema==='information_schema')).toBe(false);
 expect(result.report.targetDropped).toBe(true);expect(await restoreTargets()).toEqual(before);
 expect(await queueFingerprint(database.db)).toEqual(sourceFingerprint);
},90000);
test('detects changed queue payload even with identical job row count and cleans only the new restored target',async()=>{
 const before=await restoreTargets();
 await expect(runLocalRestoreDrill({databaseUrl:database.url,pgBin},async(db:typeof database.db)=>{
  await sql`UPDATE pgboss.job SET data=${JSON.stringify({runId:randomUUID()})}::jsonb WHERE id=${jobId}::uuid`.execute(db);
 })).rejects.toThrow('RESTORED_DATA_CHANGED');
 expect(await restoreTargets()).toEqual(before);expect(await queueFingerprint(database.db)).toEqual(sourceFingerprint);
},90000);
