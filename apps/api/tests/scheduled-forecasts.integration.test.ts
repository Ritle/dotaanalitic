import {randomBytes,randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {V1ScheduledPredictionViewSchema,V1PredictionHistorySchema} from '@dota/contracts';
import {ScenarioRepository,V1ScheduleTargetRepository,V1PredictionService,V1RuntimeRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedPredictionScenario} from '../../../tests/helpers/predictions.js';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,owner:string,cookie:string,csrf:string,id:string;
let target:Awaited<ReturnType<V1ScheduleTargetRepository['create']>>,match:ReturnType<typeof syntheticTargetMatch>;
const path=()=>`/api/v1/schedule-targets/${target.record.request.requestId}/forecasts`;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const body=()=>({requestId:randomUUID(),scenarioId:id,expectedRevision:1,targetSha256:target.sha256,targetScope:null});
const post=(payload:unknown=body())=>app.inject({method:'POST',url:path(),headers:headers(),payload});
const get=(url=path())=>app.inject({url,headers:{cookie}});
beforeEach(async()=>{
  database=await testDatabase();const input=await seedPredictionScenario(database.db),password=randomBytes(24).toString('base64url');
  owner=(await new AuthService(database.db).provision('synthetic-scheduled-owner',password)).id;
  id=(await new ScenarioRepository(database.db).save(owner,{...input,context:{...input.context,mapNumber:1}})).id;
  match=syntheticTargetMatch({scheduledAt:input.scheduledAt});await publishTargetSchedule(database.db,[match]);
  const targets=new V1ScheduleTargetRepository(database.db),p=await targets.preview(match.providerMatchId);
  target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:p.observation.id,observationSha256:p.observation.snapshotSha256,
    expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-owner-review',reason:'Synthetic reviewed organization mapping'});
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-scheduled-owner',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{vi.restoreAllMocks();await app?.close();await database?.close();},30000);
test('protects owner/session/CSRF/origin and rejects control of purpose, model and output',async()=>{
  for(const url of [path(),path()+'/'+randomUUID()])expect((await app.inject({url})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:path(),headers:{cookie,origin:'http://localhost:5173'},payload:body()})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:path(),headers:{...headers(),origin:'https://example.test'},payload:body()})).statusCode).toBe(403);
  for(const extra of [{ownerId:randomUUID()},{purpose:'what_if_single_map'},{modelId:randomUUID(),teamAWinProbability:0.9}])expect((await post({...body(),...extra})).statusCode).toBe(400);
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('saves a bounded real-map projection and exact retry after scenario and schedule changes',async()=>{
  const r=body(),response=await post(r);expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const saved=V1ScheduledPredictionViewSchema.parse(response.json());expect(saved).toMatchObject({purpose:'real_map',status:'unavailable',teamAWinProbability:null,target:{providerMatchId:match.providerMatchId}});
  expect(saved.reasons).toContain('NO_ACTIVE_MODEL');expect(response.body).not.toMatch(/source_payload|barrels|code\/|sourceAccountId|ownerId/);
  const scenarios=new ScenarioRepository(database.db),s=await scenarios.get(owner,id);
  await scenarios.save(owner,{...s.input,title:'Synthetic edited after calculation'},{id,expectedRevision:1});await publishTargetSchedule(database.db,[{...match,status:'running'}]);
  expect((await post(r)).json()).toEqual(saved);expect((await get(path()+'/'+r.requestId)).json()).toEqual(saved);
  expect((await post({...r,expectedRevision:2})).statusCode).toBe(409);
  const history=V1PredictionHistorySchema.parse((await get()).json());expect(history.items).toHaveLength(1);expect(history.items[0]?.scenarioRevision).toBe(1);
  expect((await get(`/api/v1/scenarios/${id}/predictions/${r.requestId}`)).statusCode).toBe(404);
  expect((await get(`/api/v1/scenarios/${id}/predictions`)).json().items).toHaveLength(0);
});
test('rejects exact scenario-context mismatches and forged target hashes before persisting',async()=>{
  expect((await post({...body(),targetSha256:'b'.repeat(64)})).statusCode).toBe(409);
  const scenarios=new ScenarioRepository(database.db),s=await scenarios.get(owner,id);
  for(const input of [{...s.input,teamAId:'22',teamBId:'11'},{...s.input,scheduledAt:'2099-01-03T00:00:00.000Z'},
    {...s.input,context:{...s.input.context,leagueId:null}},{...s.input,context:{...s.input.context,mapNumber:null}}]){
    const other=await scenarios.save(owner,input),r=await post({...body(),scenarioId:other.id});
    expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('scheduled_target_scenario_mismatch');
  }
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('rejects changed evidence and superseded targets without weakening runtime gates',async()=>{
  await publishTargetSchedule(database.db,[{...match,name:'Synthetic changed meeting'}]);
  let response=await post();expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('scheduled_target_source_changed');
  await publishTargetSchedule(database.db,[match]);const targets=new V1ScheduleTargetRepository(database.db),p=await targets.preview(match.providerMatchId);
  await targets.create(owner,{...target.record.request,requestId:randomUUID(),expectedRevision:1,observationId:p.observation.id,observationSha256:p.observation.snapshotSha256});
  response=await post();expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('scheduled_target_revision_changed');
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('pages immutable history, validates read boundaries and hides other targets and owners',async()=>{
  const service=await V1PredictionService.open(database.db),requests=[];
  for(let i=0;i<21;i++)requests.push(await service.createScheduled(owner,target.record.request.requestId,body()));
  const first=V1PredictionHistorySchema.parse((await get()).json()),second=V1PredictionHistorySchema.parse((await get(path()+'?offset=20')).json());
  expect(first.items).toHaveLength(20);expect(first.hasMore).toBe(true);expect(second.items).toHaveLength(1);
  expect(new Set([...first.items,...second.items].map(r=>r.id)).size).toBe(21);
  expect((await get(path()+'?offset=-1')).statusCode).toBe(400);expect((await get(path()+'/invalid')).statusCode).toBe(400);
  expect((await get(`/api/v1/schedule-targets/${randomUUID()}/forecasts/${requests[0]!.requestId}`)).statusCode).toBe(404);
  await expect(service.getScheduled(randomUUID(),target.record.request.requestId,requests[0]!.requestId)).rejects.toThrow('NOT_FOUND');
  await expect(service.scheduledHistory(randomUUID(),target.record.request.requestId,0)).rejects.toThrow('NOT_FOUND');
},30000);
test('shares bounded calculation admission with the existing what-if endpoint',async()=>{
  const original=V1RuntimeRepository.prototype.create;let release!:()=>void,entered!:()=>void;
  const inside=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  vi.spyOn(V1RuntimeRepository.prototype,'create').mockImplementation(async function(this:V1RuntimeRepository,...args){entered();await wait;return original.apply(this,args);});
  const pending=post();await inside;
  try{
    const blocked=await Promise.race([app.inject({method:'POST',url:`/api/v1/scenarios/${id}/predictions`,headers:headers(),payload:{requestId:randomUUID(),expectedRevision:1,purpose:'what_if_single_map',targetScope:null}}),
      new Promise<null>(resolve=>setTimeout(()=>resolve(null),5000))]);
    expect(blocked?.statusCode).toBe(429);expect(blocked?.headers['retry-after']).toBe('1');
  }finally{release();}
  expect((await pending).statusCode).toBe(200);
});
test('rate limits new attempts while keeping immutable reads available',async()=>{
  let first='';for(let i=0;i<6;i++){const response=await post();expect(response.statusCode).toBe(200);first||=response.json().requestId;}
  const limited=await post();expect(limited.statusCode).toBe(429);expect(limited.headers['retry-after']).toBeDefined();
  expect((await get(path()+'/'+first)).statusCode).toBe(200);
});
