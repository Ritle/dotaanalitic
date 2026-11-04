import {randomBytes,randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {V1ScheduledLifecycleHistorySchema,V1ScheduledLifecycleViewSchema} from '@dota/contracts';
import {sql,V1ScheduledLifecycleRepository,V1ScheduledLifecycleService,V1ScheduleTargetRepository,V1ScheduleResultRepository,
  V1ForecastOutcomeRepository,V1RuntimeRepository,V1JournalRepository,V1JournalService} from '@dota/db';
import {registryHash,registrySha} from '../../../packages/db/src/v1-registry.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedScheduledResult} from '../../../tests/helpers/scheduled-result.js';
import {publishTargetSchedule} from '../../../tests/helpers/schedule-target.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,f:Awaited<ReturnType<typeof seedScheduledResult>>,owner:string,cookie:string,csrf:string;
const root=(id=f.target.record.request.requestId)=>`/api/v1/schedule-targets/${id}/lifecycle`;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const body=(expectedRevision=0,action:'cancelled'|'reopened'='cancelled')=>({requestId:randomUUID(),expectedRevision,action,eventAt:null,
  sourceUrl:'https://example.test/synthetic-cancellation',reason:'Synthetic owner reviewed cancellation',confirmedByOwner:true as const});
const request=(expectedRevision=0,action:'cancelled'|'reopened'='cancelled')=>{const {confirmedByOwner:_,...b}=body(expectedRevision,action);return {...b,targetRequestId:f.target.record.request.requestId};};
const post=(payload:unknown,id?:string)=>app.inject({method:'POST',url:root(id),headers:headers(),payload});
const get=(suffix='',id?:string)=>app.inject({url:root(id)+suffix,headers:{cookie}});
beforeEach(async()=>{
  database=await testDatabase();const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-lifecycle-owner',password)).id;
  f=await seedScheduledResult(database.db,owner);app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-lifecycle-owner',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{vi.restoreAllMocks();await app?.close();await database?.close();},30000);
async function anotherTarget(){
  const match={...f.meeting,providerMatchId:'9007199254742998'};await publishTargetSchedule(database.db,[match]);
  const repo=new V1ScheduleTargetRepository(database.db),p=await repo.preview(match.providerMatchId);
  return repo.create(owner,{...f.target.record.request,requestId:randomUUID(),providerMatchId:match.providerMatchId,
    observationId:p.observation.id,observationSha256:p.observation.snapshotSha256,expectedRevision:0});
}
test('protects session, CSRF, origin and strict input without accepting clocks, identities or outcomes',async()=>{
  expect((await app.inject({url:root()})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:root(),headers:{cookie,origin:'http://localhost:5173'},payload:body()})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:root(),headers:{...headers(),origin:'https://example.test'},payload:body()})).statusCode).toBe(403);
  for(const patch of [{confirmedByOwner:false},{targetRequestId:randomUUID()},{winner:'A',recordedAt:'2000-01-01T00:00:00.000000Z'}])
    expect((await post({...body(),...patch})).statusCode).toBe(400);
  expect((await get('?beforeRevision=0')).statusCode).toBe(400);expect((await get('?ownerId=foreign')).statusCode).toBe(400);
  expect((await get()).json().items).toEqual([]);
});
test('cancels before a forecast exists, scopes nonce recovery and returns a bounded private history',async()=>{
  const other=await anotherTarget(),id=other.record.request.requestId,b=body(),a=await post(b,id);
  expect(a.statusCode).toBe(200);expect(a.headers['cache-control']).toBe('no-store');const saved=V1ScheduledLifecycleViewSchema.parse(a.json());
  expect(a.body).not.toMatch(/ownerId|source_payload|barrels/);expect((await post(b,id)).json()).toEqual(saved);
  expect((await post(b)).statusCode).toBe(409);expect((await post(b,randomUUID())).statusCode).toBe(404);
  expect((await get('',id)).json().items).toEqual([saved]);expect((await get()).json().items).toEqual([]);
  await expect(new V1ScheduledLifecycleRepository(database.db).history(randomUUID(),id)).rejects.toThrow('NOT_FOUND');
  const report=await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}});
  expect(report.report.summary.counts).toMatchObject({attempts:1,cancelled:0});expect(report.input.format).toBe('v1-journal-input-v3');
});
test('shares cancellation across target revisions, requires explicit reopening, and preserves snapshots and old reports',async()=>{
  const repo=new V1ScheduledLifecycleRepository(database.db),journals=new V1JournalRepository(database.db),old=await journals.create(owner,{requestId:randomUUID(),filters:{}});
  const r=request(),[a,b]=await Promise.all([repo.append(owner,r),repo.append(owner,r)]);expect(a).toEqual(b);
  const reports=await journals.create(owner,{requestId:randomUUID(),filters:{}});expect(reports.report.summary.counts.cancelled).toBe(1);
  const targets=new V1ScheduleTargetRepository(database.db),newTarget=await targets.create(owner,{...f.target.record.request,requestId:randomUUID(),expectedRevision:1,reason:'Synthetic revised schedule mapping'});
  expect((await repo.history(owner,newTarget.record.request.requestId)).items[0]?.sha256).toBe(a.sha256);
  await publishTargetSchedule(database.db,[]);expect((await repo.history(owner,newTarget.record.request.requestId)).items[0]?.event.request.action).toBe('cancelled');
  await expect(repo.append(owner,request())).rejects.toThrow('CONFLICT');await expect(repo.append(owner,request(1))).rejects.toThrow('lifecycle_invalid_transition');
  await expect(repo.append(owner,{...request(1,'reopened'),eventAt:'2100-01-01T00:00:00.000Z'})).rejects.toThrow('lifecycle_future_event');
  await repo.append(owner,{...request(1,'reopened'),targetRequestId:newTarget.record.request.requestId});
  expect((await journals.create(owner,{requestId:randomUUID(),filters:{}})).report.summary.counts.cancelled).toBe(0);
  expect(await journals.get(owner,old.report.request.requestId)).toEqual(old);expect(await journals.get(owner,reports.report.request.requestId)).toEqual(reports);
  expect((await new V1RuntimeRepository(database.db).get(owner,f.forecast.snapshot.request.requestId))?.sha256).toBe(f.forecast.sha256);
});
test('keeps ever-verified bindings above cancellation before refresh and after a source correction',async()=>{
  const repo=new V1ScheduledLifecycleRepository(database.db),journals=new V1JournalRepository(database.db);await repo.append(owner,request());
  const {confirmedByOwner:_,...b}=f.bindingBody();await new V1ScheduleResultRepository(database.db).bind(owner,{...b,predictionRequestId:f.forecast.snapshot.request.requestId,targetSha256:f.target.sha256});
  expect((await get()).json().verifiedBindingExists).toBe(true);
  const before=await journals.create(owner,{requestId:randomUUID(),filters:{}});expect(before.report.summary.counts.cancelled).toBe(0);
  expect(before.report.summary.rows[0]?.reasons).toContain('CANCELLATION_IGNORED_VERIFIED_BINDING');expect(before.report.summary.metrics.n).toBe(0);
  const hidden=JSON.stringify({...before.input,scheduledBindings:[]}),forged={...before.report,request:{...before.report.request,requestId:randomUUID()},
    revision:before.revision+1,previousSha256:before.sha256,inputSha256:registrySha(hidden)},forgedText=JSON.stringify(forged);
  await expect(sql`INSERT INTO v1_journal_reports(owner_user_id,request_id,request_hash,revision,previous_sha256,captured_at,input_text,input_sha256,report_text,report_sha256)
    VALUES(${owner},${forged.request.requestId},${registryHash(forged.request)},${forged.revision},${before.sha256},${forged.capturedAt}::timestamptz,
      ${hidden},${registrySha(hidden)},${forgedText},${registrySha(forgedText)})`.execute(database.db)).rejects.toThrow('journal_scheduled_binding_inventory');
  const outcomes=new V1ForecastOutcomeRepository(database.db);await outcomes.refresh(owner,{requestId:randomUUID(),predictionRequestId:f.forecast.snapshot.request.requestId,matchId:f.matchId,expectedRevision:0});
  await sql`UPDATE matches SET is_pro=false WHERE id=${f.matchId}`.execute(database.db);
  const after=await journals.create(owner,{requestId:randomUUID(),filters:{}});expect(after.report.summary.counts.cancelled).toBe(0);expect(after.report.summary.metrics.n).toBe(0);
  expect(await journals.get(owner,before.report.request.requestId)).toEqual(before);
  const view=await (await V1JournalService.open(database.db)).get(owner,after.report.request.requestId);expect(view.rows[0]?.lifecycle?.event.target.provider).toBe('pandascore');
  expect(JSON.stringify(view)).not.toContain('ownerId');
});
test('serializes simultaneous transitions, pages by exclusive revision, and admits only one HTTP writer',async()=>{
  const repo=new V1ScheduledLifecycleRepository(database.db),results=await Promise.allSettled([repo.append(owner,request()),repo.append(owner,request())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  for(let i=1;i<21;i++)await repo.append(owner,request(i,i%2?'reopened':'cancelled'));
  const first=V1ScheduledLifecycleHistorySchema.parse((await get()).json());expect(first.items).toHaveLength(20);expect(first.nextBeforeRevision).toBe(2);
  await repo.append(owner,request(21,'reopened'));expect((await get('?beforeRevision=2')).json().items.map((s:{event:{revision:number}})=>s.event.revision)).toEqual([1]);
  const service=new V1ScheduledLifecycleService(database.db);let release!:()=>void;
  vi.spyOn(V1ScheduledLifecycleRepository.prototype,'append').mockImplementationOnce(()=>new Promise(r=>{release=()=>r(results.find(r=>r.status==='fulfilled')!.value);}));
  const waiting=service.append(owner,f.target.record.request.requestId,body(22));await expect(service.append(owner,f.target.record.request.requestId,body(22))).rejects.toThrow('scheduled_lifecycle_busy');release();await waiting;
});
test('SQL independently enforces immutable events, chain/time/target binding and complete journal lifecycle inventory',async()=>{
  const repo=new V1ScheduledLifecycleRepository(database.db),saved=await repo.append(owner,request());
  await expect(sql`UPDATE v1_scheduled_lifecycle SET revision=10`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM v1_scheduled_lifecycle`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE v1_scheduled_lifecycle`.execute(database.db)).rejects.toThrow();
  await expect(database.db.transaction().execute(async tx=>{
    const time=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;
    const event={...saved.event,revision:2,previousSha256:'f'.repeat(64),recordedAt:time,request:request(1,'reopened')},text=JSON.stringify(event);
    await sql`INSERT INTO v1_scheduled_lifecycle(owner_user_id,provider_match_id,revision,request_id,request_hash,event_text,event_sha256)
      VALUES(${owner},${event.target.providerMatchId},2,${event.request.requestId},${registryHash(event.request)},${text},${registrySha(text)})`.execute(tx);
  })).rejects.toThrow('lifecycle_event_binding');
  await expect(sql`SELECT guard_v1_scheduled_issuance(${owner}::uuid,${f.meeting.providerMatchId}::bigint,'done')`.execute(database.db)).rejects.toThrow('forecast_target_owner_cancelled');
  const journals=new V1JournalRepository(database.db),original=await journals.create(owner,{requestId:randomUUID(),filters:{}});
  const input={...original.input,scheduledLifecycle:[]},inputText=JSON.stringify(input),r={...original.report,request:{...original.report.request,requestId:randomUUID()},revision:original.revision+1,
    previousSha256:original.sha256,inputSha256:registrySha(inputText)},reportText=JSON.stringify(r);
  await expect(sql`INSERT INTO v1_journal_reports(owner_user_id,request_id,request_hash,revision,previous_sha256,captured_at,input_text,input_sha256,report_text,report_sha256)
    VALUES(${owner},${r.request.requestId},${registryHash(r.request)},${r.revision},${original.sha256},${r.capturedAt}::timestamptz,
      ${inputText},${registrySha(inputText)},${reportText},${registrySha(reportText)})`.execute(database.db)).rejects.toThrow('journal_scheduled_lifecycle_inventory');
});
test('rate limits writes without preventing read recovery and records no new predictions or training targets',async()=>{
  const b=body();for(let i=0;i<6;i++)expect((await post(b)).statusCode).toBe(200);const limited=await post(b);
  expect(limited.statusCode).toBe(429);expect(limited.headers['retry-after']).toBeTruthy();expect((await get()).statusCode).toBe(200);
  expect((await sql`SELECT 1 FROM v1_scheduled_lifecycle`.execute(database.db)).rows).toHaveLength(1);
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(1);
  expect((await sql`SELECT 1 FROM training_dataset_versions`.execute(database.db)).rows).toHaveLength(0);
});
