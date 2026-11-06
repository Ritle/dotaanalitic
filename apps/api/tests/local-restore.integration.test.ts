import {test,expect,beforeAll,afterAll} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedScheduledResult} from '../../../tests/helpers/scheduled-result.js';
import {sql,V1JournalRepository,V1ScheduledLifecycleRepository,V1ModelRegistry} from '@dota/db';
import {registryFixture} from '../../../packages/db/tests/v1-registry-fixtures.js';
import {AuthService} from '../src/modules/auth/service.js';
import {runLocalRestoreDrill} from '../../../scripts/lib/local-restore-drill.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,auth:AuthService,token:string,sourceHash:unknown;
const pgBin=process.env.PG_BIN||fileURLToPath(new URL('../../../.tools/pgsql/bin/',import.meta.url));
async function targets(){return (await sql`SELECT datname FROM pg_database WHERE datname LIKE 'codex_restore_%' ORDER BY datname`.execute(database.db)).rows;}
async function migrations(db:typeof database.db){return (await sql`SELECT filename,checksum,applied_at FROM schema_migrations ORDER BY filename`.execute(db)).rows;}
async function fingerprints(db:typeof database.db){return (await sql`SELECT
  (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY request_id)) FROM v1_runtime_snapshots t) forecast,
  (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY request_id)) FROM v1_journal_reports t) report,
  (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY revision)) FROM v1_scheduled_lifecycle t) lifecycle`.execute(db)).rows[0];}
beforeAll(async()=>{
  database=await testDatabase();auth=new AuthService(database.db);const password=randomBytes(24).toString('base64url');
  const owner=(await auth.provision('synthetic-restore-owner',password)).id;token=(await auth.login('synthetic-restore-owner',password)).token;
  const f=await seedScheduledResult(database.db,owner);
  await new V1ScheduledLifecycleRepository(database.db).append(owner,{requestId:randomUUID(),targetRequestId:f.target.record.request.requestId,
    expectedRevision:0,action:'cancelled',eventAt:null,sourceUrl:'https://example.test/synthetic-restore',reason:'Synthetic owner cancellation before backup'});
  await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}});sourceHash=await fingerprints(database.db);
},30000);
afterAll(async()=>{await database?.close();},30000);
test('native dump/restore preserves every table and immutable snapshots, revokes copied sessions and keeps source usable',async()=>{
  const before=await targets();
  const sourceMigrations=await migrations(database.db);expect(sourceMigrations.length).toBeGreaterThan(0);
  const r=await runLocalRestoreDrill({databaseUrl:database.url,pgBin},async(db:typeof database.db,{databaseUrl}:{databaseUrl:string})=>{
    expect(await new AuthService(db).authenticate(token)).toBeNull();expect(await fingerprints(db)).toEqual(sourceHash);
    expect(await migrations(db)).toEqual(sourceMigrations);
    const out=execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/migrate.mjs',import.meta.url))],{
      env:{...process.env,DATABASE_URL:databaseUrl},encoding:'utf8',windowsHide:true});
    expect(out.match(/SKIP /g)).toHaveLength(sourceMigrations.length);expect(out).not.toContain('APPLIED');
    expect(await migrations(db)).toEqual(sourceMigrations);
    // Restored append-only protection is present, not just equal row counts.
    await expect(sql`DELETE FROM v1_runtime_snapshots`.execute(db)).rejects.toThrow();
  });
  expect(r.report).toMatchObject({status:'verified',forecasts:1,reports:1,sessionsRevoked:1,restoredSessionsAllRevoked:true,targetDropped:true});
  expect(await targets()).toEqual(before);expect(await fingerprints(database.db)).toEqual(sourceHash);expect(await auth.authenticate(token)).not.toBeNull();
  const manifest=JSON.parse(await readFile(fileURLToPath(new URL('../../../'+r.directory+'/backup.json',import.meta.url)),'utf8'));
  expect(manifest.archive.sha256).toBe(r.report.archiveSha256);expect(manifest.tables.some((t:{table:string})=>t.table==='auth_sessions')).toBe(true);
},90000);
test('a failed post-restore inspection still removes only the newly created target and preserves the source',async()=>{
  const before=await targets();
  await expect(runLocalRestoreDrill({databaseUrl:database.url,pgBin},async()=>{throw Error('synthetic inspection failure');})).rejects.toThrow('synthetic inspection failure');
  expect(await targets()).toEqual(before);expect(await fingerprints(database.db)).toEqual(sourceHash);expect(await auth.authenticate(token)).not.toBeNull();
},90000);
test('an inactive registered artifact without its frozen files blocks the drill before any restore target is created',async()=>{
  const before=await targets();
  // Synthetic inactive registry protocol only; no training, activation or real quality claim.
  await new V1ModelRegistry(database.db).register(registryFixture().bytes);
  await expect(runLocalRestoreDrill({databaseUrl:database.url,pgBin})).rejects.toThrow('MODEL_BUNDLE_REQUIRED');
  expect(await targets()).toEqual(before);expect(await fingerprints(database.db)).toEqual(sourceHash);expect(await auth.authenticate(token)).not.toBeNull();
},90000);
