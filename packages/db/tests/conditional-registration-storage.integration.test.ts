import {createHash,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../src/index.js';
import {ConditionalRegistrationStorage} from '../../../tools/research/conditional-registration-storage.mjs';
import {registrationFixture} from '../../../tests/fixtures/conditional-registration.mjs';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
let database:Awaited<ReturnType<typeof testDatabase>>,storage:ConditionalRegistrationStorage;
beforeAll(async()=>{database=await testDatabase();storage=new ConditionalRegistrationStorage(database.db);},30000);
afterAll(async()=>{await database?.close();},30000);
function plan(name:string){
 const p=registrationFixture().plan;p.scope[0].editionKey=name;
 p.executable.capturedAt='2020-01-01T00:00:00.000Z';p.scope[0].evidenceObservedAt=p.executable.capturedAt;
 return p;
}

/** Only this disposable test DB can seed an elapsed 35-day window. Production has no clock override.
 * All normal inserts, including assessments, run with triggers enabled.
 */
async function elapsed(name:string,receipt=true){
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 const p=plan(name);p.window={from:'2020-02-01T00:00:00.000Z',until:'2020-02-29T00:00:00.000Z',assessmentAt:'2020-03-07T00:00:00.000Z'};
 p.scope[0].earliestSeriesAt=p.window.from;const id=randomUUID(),text=JSON.stringify(p);
 await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_registrations DISABLE TRIGGER USER`.execute(tx);
  await sql`ALTER TABLE conditional_registration_receipts DISABLE TRIGGER USER`.execute(tx);
  await sql`INSERT INTO conditional_registrations(id,plan_text,plan_sha256,protocol_key,recorded_at,writer_txid)
   VALUES(${id}::uuid,${text},${hash(text)},${hash(name)},'2020-01-02T00:00:00Z','1')`.execute(tx);
  if(receipt)await sql`INSERT INTO conditional_registration_receipts(registration_id,plan_sha256,observed_committed_at,observer_txid)
   VALUES(${id}::uuid,${hash(text)},'2020-01-02T00:00:01Z','2')`.execute(tx);
  await sql`ALTER TABLE conditional_registrations ENABLE TRIGGER USER`.execute(tx);
  await sql`ALTER TABLE conditional_registration_receipts ENABLE TRIGGER USER`.execute(tx);
 });
 return storage.readRegistration(id);
}
function assessment(reg:Awaited<ReturnType<typeof storage.readRegistration>>,name='first',status='insufficient'){
 const e=registrationFixture().execution,p=reg.plan;
 const reportText=JSON.stringify({syntheticOnly:true,name,status,deployable:false});
 e.reportSha256=hash(reportText);e.manifestSha256=hash('manifest:'+name);e.status=status;
 e.scope=p.scope.map(({leagueId,editionKey})=>({leagueId,editionKey}));e.window={fromAt:p.window.from,until:p.window.until};
 e.schedule={registeredAt:reg.registeredAt!,...p.window,assessedAt:p.window.assessmentAt};
 return {registrationId:reg.id,expectedHead:null as string|null,execution:e,reportText,correctionReason:null as string|null};
}
async function directAppend(q:ReturnType<typeof assessment>,revision:number){
 const text=JSON.stringify(q.execution);
 return sql`INSERT INTO conditional_assessments(registration_id,revision,parent_execution_sha256,correction_reason,
  execution_text,execution_sha256,report_text,report_sha256,manifest_sha256)
  VALUES(${q.registrationId}::uuid,${revision},${q.expectedHead},${q.correctionReason},${text},${hash(text)},
   ${q.reportText},${q.execution.reportSha256},${q.execution.manifestSha256})`.execute(database.db);
}

it('uses server statement and separate committed-observation clocks; retries preserve exact bytes',async()=>{
 const p=plan('server-clock'),before=Date.now(),r=await storage.register(p),after=Date.now();
 expect(Date.parse(r.recordedAt)).toBeGreaterThanOrEqual(before-1000);expect(Date.parse(r.registeredAt!)).toBeLessThanOrEqual(after+1000);
 expect(Date.parse(r.registeredAt!)).toBeGreaterThanOrEqual(Date.parse(r.recordedAt));
 expect(r).toMatchObject({status:'stored_synthetic_only',clockBasis:'postgres_observed_commit',realRegistration:false,realEvaluationAllowed:false,deployable:false});
 expect(await storage.register(p)).toEqual(r);expect(await storage.read(r.id)).toMatchObject({assessments:[],head:null});
 const rows=(await sql<{writer_txid:string;observer_txid:string}>`SELECT r.writer_txid,c.observer_txid FROM conditional_registrations r
  JOIN conditional_registration_receipts c ON c.registration_id=r.id WHERE r.id=${r.id}::uuid`.execute(database.db)).rows;
 expect(rows[0]!.writer_txid).not.toBe(rows[0]!.observer_txid);
});
it('serializes identical registrations and rejects changing a frozen plan for the same scope/window',async()=>{
 const p=plan('concurrent-registration');const rs=await Promise.all([storage.register(p),storage.register(p)]);
 expect(rs[0]).toEqual(rs[1]);
 await expect(storage.register({...p,sourceReadinessSha256:'b'.repeat(64)})).rejects.toThrow();
 expect((await storage.readRegistration(rs[0].id)).plan).toEqual(p);
});
it('rejects real authorization, caller clock fields, late registration and future source evidence',async()=>{
 await expect(storage.register({...plan('real'),syntheticOnly:false})).rejects.toThrow();
 await expect(storage.register({...plan('clock'),recordedAt:'2020-01-01T00:00:00.000Z'})).rejects.toThrow();
 const late=plan('late');late.window={from:'2020-02-01T00:00:00.000Z',until:'2020-02-29T00:00:00.000Z',assessmentAt:'2020-03-07T00:00:00.000Z'};
 await expect(storage.register(late)).rejects.toThrow('registration_not_before_window');
 const future=plan('future-evidence');future.scope[0].evidenceObservedAt='2999-01-01T00:00:00.000Z';
 await expect(storage.register(future)).rejects.toThrow('evidence_after_registration');
});
it('database overwrites a forged timestamp and rejects same-transaction receipts including savepoints',async()=>{
 const p=plan('same-tx'),text=JSON.stringify(p),id=randomUUID();
 await expect(database.db.transaction().execute(async tx=>{
  const row=(await sql<{recorded_at:Date;writer_txid:string}>`INSERT INTO conditional_registrations(id,plan_text,plan_sha256,protocol_key,recorded_at,writer_txid)
   VALUES(${id}::uuid,${text},${hash(text)},'forged','2000-01-01','forged') RETURNING *`.execute(tx)).rows[0]!;
  expect(row.recorded_at.getUTCFullYear()).toBeGreaterThan(2020);expect(row.writer_txid).not.toBe('forged');
  await sql`SAVEPOINT synthetic_child`.execute(tx);
  await sql`INSERT INTO conditional_registration_receipts(registration_id,plan_sha256,observer_txid) VALUES(${id}::uuid,${hash(text)},'forged')`.execute(tx);
 })).rejects.toThrow('conditional_commit_not_observed_in_time');
 await expect(storage.readRegistration(id)).rejects.toThrow('conditional_registration_not_found');
});
it('recovers a committed registration after interruption before receipt',async()=>{
 const p=plan('resume-receipt'),text=JSON.stringify(p),id=randomUUID();
 await sql`INSERT INTO conditional_registrations(id,plan_text,plan_sha256,protocol_key,writer_txid)
  VALUES(${id}::uuid,${text},${hash(text)},'','')`.execute(database.db);
 expect(await storage.read(id)).toMatchObject({registration:{status:'commit_unconfirmed'},head:null});
 expect(await storage.register(p)).toMatchObject({id,status:'stored_synthetic_only'});
});
it('does not backdate a late receipt or append to a registration without receipt',async()=>{
 const r=await elapsed('expired-receipt',false);
 await expect(storage.register(r.plan)).rejects.toThrow('conditional_commit_not_observed_in_time');
 const request=assessment({...r,registeredAt:r.recordedAt});
 await expect(storage.append(request)).rejects.toThrow('conditional_commit_unconfirmed');
 expect(await storage.read(r.id)).toMatchObject({registration:{registeredAt:null},assessments:[]});
});
it('rejects a receipt when a timely insert commits only after the window starts',async()=>{
 const deadline=(await sql<{at:Date}>`SELECT date_trunc('milliseconds',clock_timestamp()+interval '2 seconds') AS at`.execute(database.db)).rows[0]!.at;
 const p=plan('late-commit'),id=randomUUID();
 p.window={from:deadline.toISOString(),until:new Date(+deadline+28*86400000).toISOString(),assessmentAt:new Date(+deadline+35*86400000).toISOString()};
 p.scope[0].earliestSeriesAt=p.window.from;const text=JSON.stringify(p);
 await database.db.transaction().execute(async tx=>{
  await sql`INSERT INTO conditional_registrations(id,plan_text,plan_sha256,protocol_key,writer_txid)
   VALUES(${id}::uuid,${text},${hash(text)},'','')`.execute(tx);
  await sql`SELECT pg_sleep(greatest(0,extract(epoch FROM (${deadline.toISOString()}::timestamptz-clock_timestamp())))+0.03)`.execute(tx);
 });
 await expect(storage.register(p)).rejects.toThrow('conditional_commit_not_observed_in_time');
 expect(await storage.read(id)).toMatchObject({registration:{status:'commit_unconfirmed'},assessments:[]});
});
it('refuses early assessment even when a caller supplies a completed future schedule',async()=>{
 const r=await storage.register(plan('early-assessment'));
 await expect(storage.append(assessment(r))).rejects.toThrow('assessment_not_due_or_future');
 expect((await storage.read(r.id)).assessments).toHaveLength(0);
});
it('persists insufficient as the immutable first result and exact repeat returns original bytes',async()=>{
 const r=await elapsed('first'),request=assessment(r),first=await storage.append(request);
 expect(first).toMatchObject({status:'recorded',assessment:{revision:1,execution:{status:'insufficient'},deployable:false}});
 expect(await storage.append(request)).toEqual({...first,status:'already_recorded'});
 const read=await storage.read(r.id);expect(read.assessments[0]).toEqual(first.assessment);expect(read.head).toBe(first.assessment.sha256);
});
it('concurrent identical first attempts produce one row and stable retry',async()=>{
 const r=await elapsed('same-first'),request=assessment(r);
 const results=await Promise.all([storage.append(request),storage.append(request)]);
 expect(results.map(x=>x.status).sort()).toEqual(['already_recorded','recorded']);
 expect(results[0].assessment).toEqual(results[1].assessment);expect((await storage.read(r.id)).assessments).toHaveLength(1);
});
it('concurrent different first results cannot replace each other',async()=>{
 const r=await elapsed('different-first');
 const results=await Promise.allSettled([storage.append(assessment(r,'a','negative')),storage.append(assessment(r,'b','insufficient'))]);
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);
 expect((await storage.read(r.id)).assessments).toHaveLength(1);
});
it('records corrections by exact parent, preserving negative; retry reason and stale branches are rejected',async()=>{
 const r=await elapsed('correction'),request=assessment(r,'negative','negative'),first=await storage.append(request);
 const correction={...assessment(r,'corrected'),expectedHead:first.assessment.sha256,correctionReason:'Synthetic source correction'};
 const second=await storage.append(correction);expect(second.assessment.revision).toBe(2);
 expect((await storage.read(r.id)).assessments[0]).toEqual(first.assessment);
 expect((await storage.append(request)).assessment).toEqual(first.assessment);
 expect((await storage.append(correction)).status).toBe('already_recorded');
 await expect(storage.append({...correction,correctionReason:'A different correction reason'})).rejects.toThrow('conditional_retry_reason_changed');
 await expect(storage.append({...assessment(r,'third'),expectedHead:first.assessment.sha256,correctionReason:'Synthetic stale parent attempt'})).rejects.toThrow('conditional_parent_changed');
 await expect(storage.append({...request,expectedHead:second.assessment.sha256,correctionReason:'Do not reuse the first result'})).rejects.toThrow('conditional_retry_parent_changed');
});
it('allows only one simultaneous correction of a parent',async()=>{
 const r=await elapsed('fork'),first=await storage.append(assessment(r));
 const results=await Promise.allSettled(['c1','c2'].map(name=>storage.append({...assessment(r,name),expectedHead:first.assessment.sha256,correctionReason:'Synthetic concurrent correction'})));
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((await storage.read(r.id)).assessments).toHaveLength(2);
});
it('rolls back failed persistence and never returns an unsaved first result',async()=>{
 const r=await elapsed('rollback'),request=assessment(r);
 await sql`ALTER TABLE conditional_assessments ADD CONSTRAINT synthetic_failure CHECK(registration_id<>${sql.lit(r.id)}::uuid)`.execute(database.db);
 try {await expect(storage.append(request)).rejects.toThrow();expect((await storage.read(r.id)).assessments).toEqual([]);}
 finally {await sql`ALTER TABLE conditional_assessments DROP CONSTRAINT synthetic_failure`.execute(database.db);}
 expect((await storage.append(request)).assessment.revision).toBe(1);
});
it('rejects report tampering, changed scope/code/environment/candidate and caller timestamp fields',async()=>{
 const r=await elapsed('bindings'),request=assessment(r);
 await expect(storage.append({...request,reportText:'tampered'})).rejects.toThrow('conditional_report_hash');
 await expect(storage.append({...request,recordedAt:'2020-03-07T00:00:00.000Z'})).rejects.toThrow();
 for(const changes of [{scope:[{leagueId:'999',editionKey:'other'}]},{code:{}},{environmentSha256:'b'.repeat(64)},{candidateSha256:'c'.repeat(64)},
  {schedule:{...request.execution.schedule,assessedAt:'2999-01-01T00:00:00.000Z'}},{syntheticOnly:false},{deployable:true}]){
  await expect(storage.append({...request,execution:{...request.execution,...changes}})).rejects.toThrow();
 }
 expect((await storage.read(r.id)).assessments).toEqual([]);
});
it('all three tables prohibit update/delete/truncate including cascade',async()=>{
 const r=await elapsed('immutability');await storage.append(assessment(r));
 for(const table of ['conditional_registrations','conditional_registration_receipts','conditional_assessments']){
  await expect(sql`UPDATE ${sql.id(table)} SET ${sql.id(table==='conditional_registrations'?'plan_text':table==='conditional_registration_receipts'?'plan_sha256':'report_text')}='tamper'`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM ${sql.id(table)}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE ${sql.id(table)} CASCADE`.execute(database.db)).rejects.toThrow();
 }
 expect((await storage.read(r.id)).assessments).toHaveLength(1);
});
it('direct SQL cannot bypass assessment binding or the server due date',async()=>{
 const r=await storage.register(plan('direct-early')),q=assessment(r),text=JSON.stringify(q.execution);
 await expect(sql`INSERT INTO conditional_assessments(registration_id,revision,execution_text,execution_sha256,report_text,report_sha256,manifest_sha256,recorded_at)
  VALUES(${r.id}::uuid,1,${text},${hash(text)},${q.reportText},${q.execution.reportSha256},${q.execution.manifestSha256},'2999-01-01')`.execute(database.db)).rejects.toThrow('conditional_assessment_invalid');
 const due=await elapsed('direct-mismatch'),a=assessment(due);a.execution.scope[0].leagueId='999';const changed=JSON.stringify(a.execution);
 await expect(sql`INSERT INTO conditional_assessments(registration_id,revision,execution_text,execution_sha256,report_text,report_sha256,manifest_sha256)
  VALUES(${due.id}::uuid,1,${changed},${hash(changed)},${a.reportText},${a.execution.reportSha256},${a.execution.manifestSha256})`.execute(database.db)).rejects.toThrow('conditional_assessment_invalid');
});
it('database serializes direct SQL writers and rejects a correction with no reason',async()=>{
 const r=await elapsed('direct-concurrency');
 const results=await Promise.allSettled([directAppend(assessment(r,'direct-a'),1),directAppend(assessment(r,'direct-b'),1)]);
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 const first=(await storage.read(r.id)).assessments[0];
 await expect(directAppend({...assessment(r,'direct-correction'),expectedHead:first.sha256},2)).rejects.toThrow();
 expect((await storage.read(r.id)).assessments).toHaveLength(1);
});
it('rejects reuse of any earlier report or manifest, not only the immediate parent',async()=>{
 const r=await elapsed('reuse-ancestor'),a=assessment(r,'original'),first=await storage.append(a);
 const second=await storage.append({...assessment(r,'second'),expectedHead:first.assessment.sha256,correctionReason:'Synthetic second revision'});
 const next={...assessment(r,'third'),expectedHead:second.assessment.sha256,correctionReason:'Synthetic third revision'};
 await expect(storage.append({...next,execution:{...next.execution,manifestSha256:a.execution.manifestSha256}})).rejects.toThrow('conditional_reused_result');
 await expect(storage.append({...next,reportText:a.reportText,execution:{...next.execution,reportSha256:a.execution.reportSha256}})).rejects.toThrow('conditional_reused_result');
});
it('reading fails closed if a privileged test-only modification corrupts report bytes',async()=>{
 const r=await elapsed('read-corruption');await storage.append(assessment(r));
 await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_assessments DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_assessments SET report_text='corrupted' WHERE registration_id=${r.id}::uuid`.execute(tx);
  await sql`ALTER TABLE conditional_assessments ENABLE TRIGGER USER`.execute(tx);
 });
 await expect(storage.read(r.id)).rejects.toThrow('conditional_stored_report_hash');
});
it('a committed receipt cannot be changed to attest a different plan even by restored data',async()=>{
 const r=await elapsed('receipt-corruption');
 await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_registration_receipts DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_registration_receipts SET plan_sha256=${'f'.repeat(64)} WHERE registration_id=${r.id}::uuid`.execute(tx);
  await sql`ALTER TABLE conditional_registration_receipts ENABLE TRIGGER USER`.execute(tx);
 });
 await expect(storage.read(r.id)).rejects.toThrow('conditional_receipt_plan_changed');
});
