import {randomBytes,randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {V1ScheduledBindingViewSchema,V1ScheduledOutcomeViewSchema,V1ScheduledOutcomeHistorySchema} from '@dota/contracts';
import {sql,V1PredictionService,V1ScheduledResultService,V1RuntimeRepository,V1ScheduleResultRepository,V1JournalRepository} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedScheduledResult} from '../../../tests/helpers/scheduled-result.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,f:Awaited<ReturnType<typeof seedScheduledResult>>,owner:string,cookie:string,csrf:string;
const root=()=>`/api/v1/schedule-targets/${f.target.record.request.requestId}/forecasts/${f.forecast.snapshot.request.requestId}`;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(suffix:string,payload:unknown)=>app.inject({method:'POST',url:root()+suffix,headers:headers(),payload});
const get=(suffix:string)=>app.inject({url:root()+suffix,headers:{cookie}});
const refresh=(expectedRevision=0)=>({requestId:randomUUID(),expectedRevision});
beforeEach(async()=>{
  database=await testDatabase();const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-result-owner',password)).id;
  f=await seedScheduledResult(database.db,owner);app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-result-owner',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{vi.restoreAllMocks();await app?.close();await database?.close();},30000);
test('protects owner/session/CSRF/origin and refuses labels, redirection and backdated clocks',async()=>{
  for(const suffix of ['/result-binding','/outcomes'])expect((await app.inject({url:root()+suffix})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:root()+'/result-binding',headers:{cookie,origin:'http://localhost:5173'},payload:f.bindingBody()})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:root()+'/outcomes',headers:{...headers(),origin:'https://example.test'},payload:refresh()})).statusCode).toBe(403);
  for(const patch of [{confirmedByOwner:false},{teamAWon:true},{predictionRequestId:randomUUID(),reviewedAt:'2000-01-01T00:00:00Z'}])expect((await post('/result-binding',{...f.bindingBody(),...patch})).statusCode).toBe(400);
  expect((await post('/outcomes',{...refresh(),matchId:f.matchId})).statusCode).toBe(400);
  expect((await sql`SELECT 1 FROM v1_schedule_result_bindings`.execute(database.db)).rows).toHaveLength(0);
});
test('persists a private binding and verified summary, deduplicates retries and preserves the prediction',async()=>{
  expect((await get('/result-binding')).json()).toEqual({binding:null});const body=f.bindingBody(),response=await post('/result-binding',body);
  expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const binding=V1ScheduledBindingViewSchema.parse(response.json());expect(binding.matchId).toBe(f.matchId);expect(response.body).not.toMatch(/ownerId|verification|mapNumberEvidence|source_payload|barrels/);
  expect((await post('/result-binding',body)).json()).toEqual(binding);expect((await get('/result-binding')).json()).toEqual({binding});
  expect((await post('/result-binding',{...body,providerSeriesId:'999'})).statusCode).toBe(409);
  const r=refresh(),a=await post('/outcomes',r);expect(a.statusCode).toBe(200);
  const outcome=V1ScheduledOutcomeViewSchema.parse(a.json());expect(outcome.result).toMatchObject({status:'linked',prospectiveEligible:false,rosterStatus:'matched',reasons:['NO_ISSUED_PROBABILITY'],outcome:{teamAWon:true}});
  expect(a.body).not.toMatch(/mapNumberEvidence|source_payload|ownerId/);expect((await post('/outcomes',r)).json()).toEqual(outcome);
  expect((await new V1RuntimeRepository(database.db).get(owner,f.forecast.snapshot.request.requestId))?.sha256).toBe(f.forecast.sha256);
  expect((await sql`SELECT 1 FROM training_dataset_versions`.execute(database.db)).rows).toHaveLength(0);
});
test('scopes reads and retries to the selected forecast and target before repository nonce recovery',async()=>{
  const body=f.bindingBody();expect((await post('/result-binding',body)).statusCode).toBe(200);
  const r=refresh();expect((await post('/outcomes',r)).statusCode).toBe(200);
  const wrong=`/api/v1/schedule-targets/${randomUUID()}/forecasts/${f.forecast.snapshot.request.requestId}`;
  for(const suffix of ['/result-binding','/outcomes'])expect((await app.inject({url:wrong+suffix,headers:{cookie}})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:wrong+'/result-binding',headers:headers(),payload:body})).statusCode).toBe(404);
  const predictions=await V1PredictionService.open(database.db),service=new V1ScheduledResultService(database.db,predictions);
  await expect(service.binding(randomUUID(),f.target.record.request.requestId,f.forecast.snapshot.request.requestId)).rejects.toThrow('NOT_FOUND');
  const other=await new V1RuntimeRepository(database.db).create(owner,{...f.forecast.snapshot.request,requestId:randomUUID()});
  const url=`/api/v1/schedule-targets/${f.target.record.request.requestId}/forecasts/${other.snapshot.request.requestId}/outcomes`;
  expect((await app.inject({method:'POST',url,headers:headers(),payload:r})).statusCode).toBe(409);
});
test('requires independent verified professional-map evidence and a saved binding before refresh',async()=>{
  expect((await post('/outcomes',refresh())).statusCode).toBe(409);
  expect((await post('/result-binding',{...f.bindingBody(),matchId:'999'})).statusCode).toBe(409);
  expect((await post('/result-binding',{...f.bindingBody(),providerSeriesId:'999'})).statusCode).toBe(409);
  await sql`UPDATE matches SET is_pro=false WHERE id=${f.matchId}`.execute(database.db);
  const invalid=await post('/result-binding',f.bindingBody());expect(invalid.statusCode).toBe(409);expect(invalid.json().error.code).toBe('schedule_result_map_unverified');
  expect((await sql`SELECT 1 FROM v1_schedule_result_bindings`.execute(database.db)).rows).toHaveLength(0);
  expect((await get('/outcomes')).json().items).toHaveLength(0);
});
test('uses CAS for fresh checks and retains exact prior outcomes and reports after a source correction',async()=>{
  const b=V1ScheduledBindingViewSchema.parse((await post('/result-binding',f.bindingBody())).json()),request=refresh();
  const first=V1ScheduledOutcomeViewSchema.parse((await post('/outcomes',request)).json());
  const reports=new V1JournalRepository(database.db),report=await reports.create(owner,{requestId:randomUUID(),filters:{}});
  expect((await post('/outcomes',refresh())).statusCode).toBe(409);
  await f.ingest(false);const second=V1ScheduledOutcomeViewSchema.parse((await post('/outcomes',refresh(1))).json());
  expect(second.revision).toBe(2);expect(second.result.outcome?.teamAWon).toBe(false);expect(second.previousSha256).toBe(first.sha256);
  expect((await post('/outcomes',request)).json()).toEqual(first);expect((await get('/result-binding')).json()).toEqual({binding:b});
  expect((await get('/outcomes')).json().items.map((r:{revision:number})=>r.revision)).toEqual([2,1]);
  expect(await reports.get(owner,report.report.request.requestId)).toEqual(report);
});
test('pages immutable revisions with a stable exclusive cursor even after new results arrive',async()=>{
  const predictions=await V1PredictionService.open(database.db),service=new V1ScheduledResultService(database.db,predictions),target=f.target.record.request.requestId,forecast=f.forecast.snapshot.request.requestId;
  await service.bind(owner,target,forecast,f.bindingBody());
  async function change(i:number){
    await sql`UPDATE match_players SET player_id=NULL WHERE match_id=${f.matchId}`.execute(database.db);
    await sql`UPDATE match_players SET player_id=CASE WHEN player_slot=0 AND ${i%2===1} THEN 106 WHEN player_slot=128 AND ${i%2===1} THEN 101
      WHEN side='radiant' THEN player_slot+101 ELSE player_slot-22 END WHERE match_id=${f.matchId}`.execute(database.db);
    return service.refresh(owner,target,forecast,refresh(i));
  }
  for(let i=0;i<21;i++)await change(i);
  const first=V1ScheduledOutcomeHistorySchema.parse((await get('/outcomes')).json());expect(first.items).toHaveLength(20);expect(first.nextBeforeRevision).toBe(2);
  await change(21);const last=V1ScheduledOutcomeHistorySchema.parse((await get('/outcomes?beforeRevision=2')).json());expect(last.items.map(r=>r.revision)).toEqual([1]);
  expect((await get('/outcomes?beforeRevision=0')).statusCode).toBe(400);expect((await get('/result-binding?ownerId=other')).statusCode).toBe(400);
},30000);
test('bounds concurrent result mutations before waiting for database locks',async()=>{
  const original=V1ScheduleResultRepository.prototype.bind;let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(r=>{enter=r;}),wait=new Promise<void>(r=>{release=r;});
  vi.spyOn(V1ScheduleResultRepository.prototype,'bind').mockImplementation(async function(this:V1ScheduleResultRepository,...args){enter();await wait;return original.apply(this,args);});
  const pending=post('/result-binding',f.bindingBody());await entered;
  try{const blocked=await Promise.race([post('/outcomes',refresh()),new Promise<null>(r=>setTimeout(()=>r(null),5000))]);expect(blocked?.statusCode).toBe(429);expect(blocked?.headers['retry-after']).toBe('1');}
  finally{release();}expect((await pending).statusCode).toBe(200);
});
test('rate limits binding and refresh mutations while preserving readonly recovery',async()=>{
  const b=f.bindingBody();for(let i=0;i<6;i++)expect((await post('/result-binding',b)).statusCode).toBe(200);
  expect((await post('/result-binding',b)).statusCode).toBe(429);expect((await get('/result-binding')).statusCode).toBe(200);
  const r=refresh();for(let i=0;i<6;i++)expect((await post('/outcomes',r)).statusCode).toBe(200);
  expect((await post('/outcomes',r)).statusCode).toBe(429);expect((await get('/outcomes')).statusCode).toBe(200);
});
