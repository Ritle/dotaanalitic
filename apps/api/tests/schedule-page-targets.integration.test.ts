import {randomBytes,randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PageScheduleTargetRepository,ScenarioRepository,sql} from '@dota/db';
import {schedulePageEndpoint,type UpcomingMatch} from '@dota/contracts';
import {registrySha,registryHash} from '../../../packages/db/src/v1-registry.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedPredictionScenario} from '../../../tests/helpers/predictions.js';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,owner:string,cookie:string,csrf:string,scenarioId:string;
let match:UpcomingMatch,repo:PageScheduleTargetRepository;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
async function publish(page:number,data:UpcomingMatch[],fetchedAt=new Date(Date.now()-100).toISOString()){
 const snapshot={data,source:{provider:'pandascore',adapterVersion:'synthetic-page-target',endpoint:schedulePageEndpoint(page),fetchedAt,
  knownAt:null,payloadSha256:'b'.repeat(64),attempts:1,rateLimitRemaining:null}},text=JSON.stringify(snapshot);
 await sql`INSERT INTO upcoming_page_observations(page,source_endpoint,source_payload_sha256,source_fetched_at,snapshot_sha256,snapshot_text)
  VALUES(${page},${snapshot.source.endpoint},${snapshot.source.payloadSha256},${fetchedAt},${registrySha(text)},${text})`.execute(database.db);
}
async function request(){const p=await repo.preview(match.providerMatchId);return {requestId:randomUUID(),providerMatchId:match.providerMatchId,
 observationId:p.observation.id,observationSha256:p.observation.snapshotSha256,expectedRevision:0,mapNumber:1,
 providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-pages',reason:'Synthetic owner reviewed numeric team mapping'};}
const preview=()=>app.inject({url:`/api/v1/upcoming/${match.providerMatchId}/target-preview`,headers:{cookie}});
const create=(payload:unknown)=>app.inject({method:'POST',url:'/api/v1/schedule-targets',headers:headers(),payload});
beforeEach(async()=>{
 database=await testDatabase();const input=await seedPredictionScenario(database.db),password=randomBytes(24).toString('base64url');
 owner=(await new AuthService(database.db).provision('synthetic-page-target-owner',password)).id;
 scenarioId=(await new ScenarioRepository(database.db).save(owner,{...input,context:{...input.context,mapNumber:1}})).id;
 match=syntheticTargetMatch({scheduledAt:input.scheduledAt});repo=new PageScheduleTargetRepository(database.db);
 await publishTargetSchedule(database.db,[syntheticTargetMatch({providerMatchId:'999'})]);await publish(2,[match]);
 app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-page-target-owner',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
test('namespaces colliding source IDs, preserves original bytes, saves/retries a page-two target and unavailable forecast',async()=>{
 const before=(await sql`SELECT * FROM upcoming_source_observations`.execute(database.db)).rows;
 const p=await preview();expect(p.statusCode,p.body).toBe(200);expect(p.json().observation.endpoint).toBe(schedulePageEndpoint(2));
 const req=await request(),response=await create(req);expect(response.statusCode,response.body).toBe(200);const target=response.json();
 expect(target.record.probability).toBeNull();expect(target.record.warnings).toContain('SCHEDULE_PAGES_SOURCE_V2');
 const stored=(await sql<{observation_id:null;page_observation_id:string}>`SELECT observation_id,page_observation_id FROM v1_schedule_targets`.execute(database.db)).rows[0]!;
 expect(stored.observation_id).toBeNull();expect(String(stored.page_observation_id)).toBe(req.observationId);
 const forecast={requestId:randomUUID(),scenarioId,expectedRevision:1,targetSha256:target.sha256,targetScope:null};
 const url=`/api/v1/schedule-targets/${req.requestId}/forecasts`;
 const result=await app.inject({method:'POST',url,headers:headers(),payload:forecast});expect(result.statusCode,result.body).toBe(200);
 expect(result.json()).toMatchObject({status:'unavailable',teamAWinProbability:null});expect(result.json().reasons).toContain('NO_ACTIVE_MODEL');
 const snapshot=(await sql<{snapshot_text:string}>`SELECT snapshot_text FROM v1_runtime_snapshots`.execute(database.db)).rows[0]!;
 expect(JSON.parse(snapshot.snapshot_text).targetReview.scheduleBinding).toMatchObject({format:'v1-schedule-runtime-binding-v2',currentObservation:{endpoint:schedulePageEndpoint(2)}});
 await publish(3,[{...match,status:'running'}],new Date().toISOString());
 expect((await create(req)).json()).toEqual(target);
 expect((await app.inject({method:'POST',url,headers:headers(),payload:forecast})).json()).toEqual(result.json());
 expect((await sql`SELECT * FROM upcoming_source_observations`.execute(database.db)).rows).toEqual(before);
 expect((await sql`SELECT * FROM matches`.execute(database.db)).rows).toHaveLength(0);
});
test('uses fetched time across moving pages, ignores later omissions and demands a new review for changed participants',async()=>{
 const req=await request();await publish(3,[{...match,name:'Older received later'}],new Date(Date.now()-120000).toISOString());
 expect((await preview()).json().observation.endpoint).toBe(schedulePageEndpoint(2));
 await publish(4,[],new Date().toISOString());expect((await preview()).json().omittingLaterPages).toBe(1);
 expect((await create(req)).statusCode).toBe(200);
 await publish(1+4,[{...match,opponents:[match.opponents[0]!,{providerTeamId:'76',name:'Changed'}]}],new Date().toISOString());
 expect((await create({...req,requestId:randomUUID(),expectedRevision:1})).json().error.code).toBe('schedule_target_source_changed');
 const r=await request();expect((await create({...r,expectedRevision:1})).json().error.code).toBe('schedule_target_mapping');
});
test('a fresh empty other page cannot refresh stale evidence and a future source clock is rejected in SQL',async()=>{
 const other={...match,providerMatchId:'12345'};await publish(7,[other],new Date(Date.now()-300000).toISOString());
 match=other;await publish(8,[],new Date().toISOString());
 expect((await preview()).json()).toMatchObject({eligible:false,reasons:['SCHEDULE_SOURCE_STALE']});
 expect((await create(await request())).json().error.code).toBe('schedule_source_stale');
 await expect(publish(9,[match],new Date(Date.now()+60000).toISOString())).rejects.toThrow();
 expect((await sql`SELECT * FROM v1_schedule_targets`.execute(database.db)).rows).toHaveLength(0);
});
test('SQL independently rejects forged source namespaces, mapping and unsupported output; sources remain immutable',async()=>{
 const saved=await repo.create(owner,await request());
 for(const patch of [{probability:0.8},{observation:{...saved.record.observation,endpoint:schedulePageEndpoint(1)}}]){
  await expect(database.db.transaction().execute(async tx=>{
   const q={...saved.record.request,requestId:randomUUID(),expectedRevision:1};
   const at=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;
   const text=JSON.stringify({...saved.record,...patch,request:q,revision:2,previousSha256:saved.sha256,selectedAt:at});
   await sql`INSERT INTO v1_schedule_targets(owner_user_id,provider_match_id,revision,request_id,request_hash,page_observation_id,record_text,record_sha256)
    VALUES(${owner},${q.providerMatchId},2,${q.requestId},${registryHash(q)},${q.observationId},${text},${registrySha(text)})`.execute(tx);
  })).rejects.toThrow('schedule_target_record_binding');
 }
 for(const q of [sql`UPDATE upcoming_page_observations SET page=3`,sql`DELETE FROM upcoming_page_observations`,sql`TRUNCATE upcoming_page_observations CASCADE`,sql`TRUNCATE upcoming_source_observations CASCADE`])await expect(q.execute(database.db)).rejects.toThrow();
 await expect(repo.get(randomUUID(),saved.record.request.requestId)).rejects.toThrow('NOT_FOUND');
});
test('changed and cancelled page-two meetings block new forecasts but page moves preserve the mapping',async()=>{
 const target=await repo.create(owner,await request()),url=`/api/v1/schedule-targets/${target.record.request.requestId}/forecasts`;
 const body=()=>({requestId:randomUUID(),scenarioId,expectedRevision:1,targetSha256:target.sha256,targetScope:null});
 await publish(3,[match],new Date().toISOString());
 let r=await app.inject({method:'POST',url,headers:headers(),payload:body()});expect(r.statusCode,r.body).toBe(200);
 for(const patch of [{name:'Changed meeting'},{status:'canceled'}]){
  await publish(3,[{...match,...patch}],new Date().toISOString());
  r=await app.inject({method:'POST',url,headers:headers(),payload:body()});expect(r.statusCode,r.body).toBe(409);
 }
 expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(1);
});
