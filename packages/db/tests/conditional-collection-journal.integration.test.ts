import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRealRegistrationStore} from '../../../tools/research/conditional-real-registration-store.mjs';
import {ConditionalCollectionJournal,collectionJournalPaths} from '../../../tools/research/conditional-collection-journal.mjs';
import {inspectRealRegistrationEnvironment,realSha} from '../../../tools/research/conditional-real-registration.mjs';
import {collectorFixture,map} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,registrationId:string,packageSha:string,journal:ConditionalCollectionJournal;
const at='2026-11-20T00:00:00.000Z';
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await sql`CREATE OR REPLACE FUNCTION conditional_collection_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-journal-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 const server=(await sql<{at:Date}>`SELECT conditional_collection_clock() AS at`.execute(database.db)).rows[0]!.at;expect(Math.abs(server.getTime()-Date.now())).toBeLessThan(2000);
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit("SELECT '2026-11-15T01:00:00.000Z'::timestamptz")}`.execute(database.db);
 const f=await collectorFixture(owner);for(const path of collectionJournalPaths)f.p.executable.code[path]=realSha(await readFile(path));
 f.p.executable.environmentText=await inspectRealRegistrationEnvironment();f.p.executable.environmentSha256=realSha(f.p.executable.environmentText);
 const text=JSON.stringify(f.p),r=await new ConditionalRealRegistrationStore(database.db).register(owner,text,realSha(text));registrationId=r.id;packageSha=r.packageSha256;
 journal=new ConditionalCollectionJournal(database.db);
},60000);
beforeEach(async()=>{
 await database.db.transaction().execute(async tx=>{
  for(const table of ['conditional_transport_receipts','conditional_collection_events','conditional_collection_journals'])await sql`ALTER TABLE ${sql.id(table)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_transport_receipts,conditional_collection_events,conditional_collection_journals`.execute(tx);
  for(const table of ['conditional_transport_receipts','conditional_collection_events','conditional_collection_journals'])await sql`ALTER TABLE ${sql.id(table)} ENABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE app_users SET is_active=true,account_role='owner' WHERE id=${owner}::uuid`.execute(tx);
 });await clock(at);
},30000);
afterAll(async()=>{await database?.close();},30000);
const init=()=>journal.initialize(owner,registrationId,packageSha,{syntheticOnly:true});
const read=()=>journal.read(owner,registrationId);
const append=(head:string,command:object,id=randomUUID())=>journal.append(owner,registrationId,head,id,command);
async function scanned(){const r=await init();return append(r.headSha256,{kind:'scan',scanId:randomUUID()});}
async function reserved(){const s=await scanned(),requestId=randomUUID();return {requestId,saved:await append(s.headSha256,{kind:'reserve',requestId,endpoint:'/leagues/90001/matches'})};}
const captured=(rows:unknown)=>{const rawBody=JSON.stringify(rows);return {status:'captured',rawBody,payloadSha256:realSha(rawBody)};};

it('persists the chain before returning a reservation and replays after constructing a new service',async()=>{
 const {requestId,saved}=await reserved();expect(saved.operationStatus).toBe('recorded');expect(saved.report.attempts.total).toBe(1);
 expect(saved.log.events.at(-1)).toMatchObject({kind:'request_started',requestId,at});expect(saved.dispatchAllowed).toBe(false);
 const restarted=await new ConditionalCollectionJournal(database.db).read(owner,registrationId);expect(restarted.headSha256).toBe(saved.headSha256);expect(restarted.report.attempts.total).toBe(1);
 const done=await append(saved.headSha256,{kind:'complete',requestId,result:captured([map()])});expect(done.report.observedPossibleMaps).toBe(1);expect(done.report.denominatorComplete).toBe(false);
});
it('initialization is idempotent but cannot change origin or package',async()=>{
 const a=await init(),b=await init();expect(a.headSha256).toBe(b.headSha256);
 await expect(journal.initialize(owner,registrationId,packageSha,{syntheticOnly:false})).rejects.toThrow('journal_origin_changed');
 await expect(journal.initialize(owner,registrationId,'0'.repeat(64),{syntheticOnly:true})).rejects.toThrow('expected_registration_hash');
});
it('concurrent identical commands consume once; changed command bytes or parent reject',async()=>{
 const s=await scanned(),op=randomUUID(),c={kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'};
 const results=await Promise.all([append(s.headSha256,c,op),append(s.headSha256,c,op)]);
 expect(results.map(r=>r.operationStatus).sort()).toEqual(['already_recorded','recorded']);expect((await read()).report.attempts.total).toBe(1);
 await expect(append(s.headSha256,{...c,endpoint:'/leagues/90002/matches'},op)).rejects.toThrow('operation_payload_changed');
 await expect(append('0'.repeat(64),c,op)).rejects.toThrow('operation_parent_changed');
});
it('two different commands from the same head cannot fork or reserve twice',async()=>{
 const s=await scanned(),results=await Promise.allSettled([1,2].map(()=>append(s.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await read()).report.attempts.total).toBe(1);
 await expect(append(s.headSha256,{kind:'scan',scanId:randomUUID()})).rejects.toThrow('journal_head_conflict');
});
it('rollback never leaves a consumed reservation; retry can commit',async()=>{
 const s=await scanned(),op=randomUUID(),c={kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'};
 await sql`ALTER TABLE conditional_collection_events ADD CONSTRAINT synthetic_failure CHECK(sequence<1)`.execute(database.db);
 try{await expect(append(s.headSha256,c,op)).rejects.toThrow();expect((await read()).headSha256).toBe(s.headSha256);}
 finally{await sql`ALTER TABLE conditional_collection_events DROP CONSTRAINT synthetic_failure`.execute(database.db);}
 expect((await append(s.headSha256,c,op)).report.attempts.total).toBe(1);
});
it('expired recovery retains the attempt, rejects early recovery and fences a late response',async()=>{
 const {requestId,saved}=await reserved();const recovery={kind:'recover',requestId,reason:'Synthetic worker crash; actual transport result is unknown'};
 await expect(append(saved.headSha256,recovery)).rejects.toThrow('recovery_not_expired');
 await clock('2026-11-20T00:02:00.000Z');const r=await append(saved.headSha256,recovery);expect(r.report.attempts.total).toBe(1);expect(r.report.requests.at(-1).reason).toBe('recovery_outcome_unknown');
 await expect(append(r.headSha256,{kind:'complete',requestId,result:captured([])})).rejects.toThrow();
 await clock('2026-11-20T00:02:05.000Z');expect((await append(r.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'})).report.attempts.total).toBe(2);
});
it('Retry-After survives service restart and does not permit a new request before its exact boundary',async()=>{
 const {requestId,saved}=await reserved();const r=await append(saved.headSha256,{kind:'complete',requestId,result:{status:'failed',httpStatus:429,code:'rate_limited',retryAfterAt:'2026-11-20T01:00:00.000Z'}});
 await expect(new ConditionalCollectionJournal(database.db).append(owner,registrationId,r.headSha256,randomUUID(),{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'})).rejects.toThrow(/retry_after/);
 await clock('2026-11-20T01:00:00.000Z');expect((await append(r.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'})).report.attempts.total).toBe(2);
});
it('forbids caller clocks, recovery deadlines and unauthorized or inactive owners',async()=>{
 const s=await scanned();await expect(append(s.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches',at:'2020-01-01T00:00:00.000Z'})).rejects.toThrow();
 await expect(journal.read(randomUUID(),registrationId)).rejects.toThrow('active_owner_required');
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);await expect(read()).rejects.toThrow('active_owner_required');
});
it('collection window closes at equality but an exact retry remains an observation, not another dispatch',async()=>{
 const s=await scanned(),op=randomUUID(),c={kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'};await append(s.headSha256,c,op);
 await clock('2026-12-25T00:00:00.000Z');const retry=await append(s.headSha256,c,op);expect(retry.operationStatus).toBe('already_recorded');expect(retry.dispatchAllowed).toBe(false);
 const r=await append(retry.headSha256,{kind:'recover',requestId:c.requestId,reason:'Synthetic stale worker recovered after the fixed collection deadline'});
 await expect(append(r.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'})).rejects.toThrow(/collection_window/);
});
it('invalid cursor, response SHA or unregistered endpoint rolls back without changing the head',async()=>{
 const s=await scanned();await expect(append(s.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/20359/matches'})).rejects.toThrow();
 await expect(append(s.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches?less_than_match_id=1'})).rejects.toThrow(/cursor/);
 const requestId=randomUUID(),r=await append(s.headSha256,{kind:'reserve',requestId,endpoint:'/leagues/90001/matches'});
 await expect(append(r.headSha256,{kind:'complete',requestId,result:{...captured([]),payloadSha256:'0'.repeat(64)}})).rejects.toThrow();expect((await read()).headSha256).toBe(r.headSha256);
});
it('tables refuse UPDATE DELETE and TRUNCATE; read detects privileged corruption',async()=>{
 await reserved();for(const table of ['conditional_collection_events','conditional_collection_journals']){
  await expect(sql`UPDATE ${sql.id(table)} SET registration_id=registration_id`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM ${sql.id(table)}`.execute(database.db)).rejects.toThrow();await expect(sql`TRUNCATE ${sql.id(table)} CASCADE`.execute(database.db)).rejects.toThrow();
 }
 await database.db.transaction().execute(async tx=>{await sql`ALTER TABLE conditional_collection_events DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_collection_events SET head_sha256=${'f'.repeat(64)} WHERE sequence=1`.execute(tx);await sql`ALTER TABLE conditional_collection_events ENABLE TRIGGER USER`.execute(tx);});
 await expect(read()).rejects.toThrow('event_chain_hash');
});
it('SQL overwrites a forged caller timestamp and computes event/hash itself',async()=>{
 const s=await scanned(),requestId=randomUUID(),command=JSON.stringify({kind:'reserve',requestId,endpoint:'/leagues/90001/matches'});
 await sql`INSERT INTO conditional_collection_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256,recorded_at,event_text,head_sha256)
  VALUES(${registrationId}::uuid,1,${randomUUID()}::uuid,${command},${realSha(command)},${s.headSha256},'2000-01-01','forged','forged')`.execute(database.db);
 const r=await read();expect(r.log.events[1].at).toBe(at);expect(r.report.attempts.total).toBe(1);expect(r.headSha256).not.toBe('forged');
});
it('daily and total SQL budgets persist across dates and all 1000 reservations remain replayable',async()=>{
 const s=await scanned();
 await sql`CREATE OR REPLACE FUNCTION conditional_collection_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE
  AS ${sql.lit("SELECT current_setting('codex.collection_at')::timestamptz")}`.execute(database.db);
 // Server-side loop avoids thousands of network roundtrips. Real INSERT guards remain enabled.
 const block=`DECLARE parent TEXT:='${s.headSha256}';reg UUID:='${registrationId}';cmd TEXT;rid UUID;seq INTEGER:=1;day_at TIMESTAMPTZ;
 BEGIN
 FOR i IN 1..1000 LOOP
  day_at:='2026-11-20T00:00:00Z'::timestamptz+((i-1)/100)*interval '1 day';
  PERFORM set_config('codex.collection_at',day_at::text,true);rid:=gen_random_uuid();
  cmd:=jsonb_build_object('kind','reserve','requestId',rid::text,'endpoint','/leagues/90001/matches')::text;
  INSERT INTO conditional_collection_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
   VALUES(reg,seq,gen_random_uuid(),cmd,encode(sha256(convert_to(cmd,'UTF8')),'hex'),parent) RETURNING head_sha256 INTO parent;seq:=seq+1;
  cmd:=jsonb_build_object('kind','complete','requestId',rid::text,'result',jsonb_build_object('status','captured','rawBody','[]','payloadSha256','${realSha('[]')}'))::text;
  INSERT INTO conditional_collection_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
   VALUES(reg,seq,gen_random_uuid(),cmd,encode(sha256(convert_to(cmd,'UTF8')),'hex'),parent) RETURNING head_sha256 INTO parent;seq:=seq+1;
  IF i=100 THEN
   BEGIN
    cmd:=jsonb_build_object('kind','reserve','requestId',gen_random_uuid()::text,'endpoint','/leagues/90001/matches')::text;
    INSERT INTO conditional_collection_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
     VALUES(reg,seq,gen_random_uuid(),cmd,encode(sha256(convert_to(cmd,'UTF8')),'hex'),parent);
    RAISE EXCEPTION 'daily_budget_was_not_enforced';
   EXCEPTION WHEN check_violation THEN IF SQLERRM<>'collection_daily_budget_exhausted' THEN RAISE; END IF; END;
  END IF;
 END LOOP;
 END;`;
 try{await sql`DO ${sql.lit(block)}`.execute(database.db);}finally{await clock('2026-11-30T00:00:00.000Z');}
 const r=await read();expect(r.report.attempts.total).toBe(1000);expect(Object.values(r.report.attempts.byUtcDay)).toEqual(Array(10).fill(100));
 const command=JSON.stringify({kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'});
 await expect(sql`INSERT INTO conditional_collection_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
  VALUES(${registrationId}::uuid,2001,${randomUUID()}::uuid,${command},${realSha(command)},${r.headSha256})`.execute(database.db)).rejects.toThrow('collection_total_budget_exhausted');
 await expect(append(r.headSha256,JSON.parse(command))).rejects.toThrow('total_budget_exhausted');
},120000);
it('the final SQL clock rejects a reservation if the window closes after application validation',async()=>{
 const s=await scanned();
 await sql`CREATE OR REPLACE FUNCTION conditional_collection_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE
  AS ${sql.lit("SELECT coalesce(nullif(current_setting('codex.collection_at',true),''),'2026-11-20T00:00:00Z')::timestamptz")}`.execute(database.db);
 await sql`CREATE FUNCTION synthetic_close_window() RETURNS TRIGGER LANGUAGE plpgsql AS ${sql.lit("BEGIN PERFORM set_config('codex.collection_at','2026-12-25T00:00:00Z',true); RETURN NEW; END;")}`.execute(database.db);
 await sql`CREATE TRIGGER aaa_synthetic_close_window BEFORE INSERT ON conditional_collection_events FOR EACH ROW EXECUTE FUNCTION synthetic_close_window()`.execute(database.db);
 try{await expect(append(s.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'})).rejects.toThrow('collection_window_closed');}
 finally{await sql`DROP TRIGGER aaa_synthetic_close_window ON conditional_collection_events`.execute(database.db);await sql`DROP FUNCTION synthetic_close_window()`.execute(database.db);await clock(at);}
 expect((await read()).headSha256).toBe(s.headSha256);
});
it('UUID letter case does not create a second operation or prevent completing the same request',async()=>{
 const s=await scanned(),op='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const first=await append(s.headSha256,{kind:'reserve',requestId:requestId.toUpperCase(),endpoint:'/leagues/90001/matches'},op.toUpperCase());
 const retry=await append(s.headSha256,{kind:'reserve',requestId,endpoint:'/leagues/90001/matches'},op);
 expect(retry.operationStatus).toBe('already_recorded');expect(retry.report.attempts.total).toBe(1);
 expect((await append(first.headSha256,{kind:'complete',requestId,result:captured([])})).report.attempts.total).toBe(1);
});
