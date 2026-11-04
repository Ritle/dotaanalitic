import {randomBytes,randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {V1ScheduleTargetRepository,sql} from '@dota/db';
import {registrySha,registryHash} from '../../../packages/db/src/v1-registry.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedTargetCatalog,publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,owner:string,cookie:string,csrf:string,source:Awaited<ReturnType<typeof publishTargetSchedule>>;
const match=syntheticTargetMatch(),base='/api/v1/schedule-targets';
const request=()=>({requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:source.id,observationSha256:source.sha,expectedRevision:0,mapNumber:1,
  providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic',reason:'Synthetic owner checked team and event mapping'});
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(payload:unknown)=>app.inject({method:'POST',url:base,headers:headers(),payload});
beforeEach(async()=>{
  database=await testDatabase();await seedTargetCatalog(database.db);source=await publishTargetSchedule(database.db,[match]);
  const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-target',password)).id;
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-target',password}});
  const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(x=>x.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
test('protects preview/history/read/create and rejects forged fields or missing CSRF',async()=>{
  for(const url of [`/api/v1/upcoming/${match.providerMatchId}/target-preview`,`/api/v1/upcoming/${match.providerMatchId}/targets`,base+'/'+randomUUID()])
    expect((await app.inject({url})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:base,headers:{cookie},payload:request()})).statusCode).toBe(403);
  for(const extra of [{winner:'A'},{ownerId:owner},{selectedAt:new Date().toISOString()},{providerSeriesId:'1'}])expect((await post({...request(),...extra})).statusCode).toBe(400);
  expect((await sql`SELECT 1 FROM v1_schedule_targets`.execute(database.db)).rows).toHaveLength(0);
});
test('freezes known source and explicit orientation, retries exactly and never creates a prediction or canonical map',async()=>{
  const req={...request(),providerTeamAId:'75',providerTeamBId:'74'},response=await post(req);expect(response.statusCode,response.body).toBe(200);
  const saved=response.json();expect(saved.record).toMatchObject({revision:1,provider:'pandascore',mapBinding:'pending',probability:null,mappingBasis:'owner_reviewed'});
  expect(response.headers['cache-control']).toBe('no-store');expect(response.body).not.toContain('owner_user_id');
  await publishTargetSchedule(database.db,[{...match,status:'running'}]);
  expect((await post(req)).json()).toEqual(saved);
  expect((await app.inject({url:base+'/'+req.requestId,headers:{cookie}})).json()).toEqual(saved);
  await expect(new V1ScheduleTargetRepository(database.db).get(randomUUID(),req.requestId)).rejects.toThrow('NOT_FOUND');
  expect((await post({...req,reason:'Changed synthetic review reason'})).statusCode).toBe(409);
  for(const table of ['prediction_runs','matches','v1_forecast_outcome_revisions'])expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);
});
test('rejects changed sources and stale revisions; omitted later pages do not cancel a pinned meeting',async()=>{
  const req=request();await publishTargetSchedule(database.db,[{...match,scheduledAt:new Date(Date.now()+7200000).toISOString()}]);
  expect((await post(req)).statusCode).toBe(409);
  source=await publishTargetSchedule(database.db,[match]);await publishTargetSchedule(database.db,[]);
  const fresh=request(),repo=new V1ScheduleTargetRepository(database.db),a=await repo.create(owner,fresh);
  expect(a.record.omittingLaterPages).toBe(1);
  const [x,y]=await Promise.all([repo.create(owner,{...fresh}),repo.create(owner,{...fresh})]);expect(x).toEqual(y);
  const b=await repo.create(owner,{...request(),expectedRevision:1,teamAId:'22',teamBId:'11'});expect(b.record.previousSha256).toBe(a.sha256);
  await expect(repo.create(owner,request())).rejects.toThrow('CONFLICT');
  expect((await repo.history(owner,match.providerMatchId,2)).items).toEqual([a]);
  expect(await repo.get(owner,fresh.requestId)).toEqual(a);
});
test('refuses started, unknown-time or changed-opponent targets and cannot rewrite stored evidence',async()=>{
  const repo=new V1ScheduleTargetRepository(database.db),a=await repo.create(owner,request());
  for(const q of [sql`UPDATE v1_schedule_targets SET revision=4`,sql`DELETE FROM v1_schedule_targets`,sql`TRUNCATE v1_schedule_targets`])await expect(q.execute(database.db)).rejects.toThrow();
  for(const patch of [{status:'running'},{scheduledAt:null},{scheduledAt:new Date(Date.now()-1000).toISOString()},{opponents:[]}]){
    source=await publishTargetSchedule(database.db,[{...match,...patch}]);expect((await post({...request(),expectedRevision:1})).statusCode).toBe(409);
  }
  source=await publishTargetSchedule(database.db,[{...match,opponents:[match.opponents[0]!,{providerTeamId:'99',name:'Replacement'}]}]);
  expect((await post({...request(),expectedRevision:1})).statusCode).toBe(409);expect(await repo.get(owner,a.record.request.requestId)).toEqual(a);
});
test('SQL enforces pending-only records and current source binding independently of HTTP',async()=>{
  const repo=new V1ScheduleTargetRepository(database.db),a=await repo.create(owner,request());
  await expect(database.db.transaction().execute(async tx=>{
    const req={...request(),expectedRevision:1},r={...a.record,request:req,revision:2,previousSha256:a.sha256,probability:0.9,
      selectedAt:(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at};
    const text=JSON.stringify(r);
    return sql`INSERT INTO v1_schedule_targets(owner_user_id,provider_match_id,revision,request_id,request_hash,observation_id,record_text,record_sha256)
      VALUES(${owner},${req.providerMatchId},2,${req.requestId},${registryHash(req)},${req.observationId},${text},${registrySha(text)})`.execute(tx);
  })).rejects.toThrow('schedule_target_record_binding');
  expect((await repo.history(owner,match.providerMatchId)).items).toHaveLength(1);
});
test('rejects corrupt newest evidence rather than silently reverting to an earlier valid meeting',async()=>{
  await sql`INSERT INTO upcoming_source_observations(cache_key,provider,source_endpoint,source_payload_sha256,source_fetched_at,snapshot_sha256,snapshot_text)
    SELECT cache_key,provider,source_endpoint,source_payload_sha256,source_fetched_at,${'0'.repeat(64)},snapshot_text
    FROM upcoming_source_observations WHERE id=${source.id}::bigint`.execute(database.db);
  const response=await app.inject({url:`/api/v1/upcoming/${match.providerMatchId}/target-preview`,headers:{cookie}});
  expect(response.statusCode).toBe(503);expect(response.json().error.code).toBe('schedule_target_source_invalid');
  expect((await post(request())).statusCode).toBe(503);
  expect((await sql`SELECT 1 FROM v1_schedule_targets`.execute(database.db)).rows).toHaveLength(0);
});
