import {randomBytes,randomUUID} from 'node:crypto';
import {test,expect,beforeAll,afterAll} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {ScenarioRepository,V1ScheduleTargetRepository,V1RuntimeRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../tests/helpers/predictions';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';
import {JournalResultSchema} from '../src/modules/scenarios/journal-result-contract';
import {JournalResultService} from '../src/modules/scenarios/journal-result-service';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,requests:string[],fetches=0,ownerId:string,csrf:string;
const token='synthetic-results-test-token';
beforeAll(async()=>{
 database=await testDatabase();const input=await seedPredictionScenario(database.db),password=randomBytes(24).toString('hex');
 const owner=(await new AuthService(database.db).provision('synthetic-journal-results',password)).id;
 ownerId=owner;
 const scenario=await new ScenarioRepository(database.db).save(owner,{...input,context:{...input.context,mapNumber:1}});
 const m=syntheticTargetMatch({scheduledAt:input.scheduledAt});await publishTargetSchedule(database.db,[m]);
 const targets=new V1ScheduleTargetRepository(database.db),p=await targets.preview(m.providerMatchId);
 const t=await targets.create(owner,{requestId:randomUUID(),providerMatchId:m.providerMatchId,observationId:p.observation.id,observationSha256:p.observation.snapshotSha256,
  expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic',reason:'Synthetic reviewed mapping for result test'});
 requests=[randomUUID(),randomUUID()];
 for(const requestId of requests)await new V1RuntimeRepository(database.db).create(owner,{requestId,scenarioId:scenario.id,expectedRevision:1,purpose:'real_map',targetScope:null,
  realTarget:{provider:'pandascore',bindingVersion:1,providerMatchId:m.providerMatchId,mapNumber:1,targetRequestId:t.record.request.requestId,targetSha256:t.sha256}});
 app=await buildApp(readConfig({DATABASE_URL:database.url,PANDASCORE_API_TOKEN:token}),{db:database.db,logger:false,pandascoreFetch:async(url)=>{
  fetches++;expect(url.pathname).toBe('/matches/'+m.providerMatchId);
  return new Response(JSON.stringify({id:m.providerMatchId,name:'Synthetic',status:'finished',videogame:{slug:'dota-2'},forfeit:false,
   opponents:[{type:'Team',opponent:{id:75,name:'B'}},{type:'Team',opponent:{id:74,name:'A'}}],
   games:[{id:123,match_id:m.providerMatchId,position:1,status:'finished',finished:true,forfeit:false,begin_at:'2026-01-01T10:00:00Z',end_at:'2026-01-01T11:00:00Z',winner:{id:fetches>1?74:75,type:'Team'}}]}));
 }});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-journal-results',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');
 csrf=login.json().csrfToken;
},60000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const path=(id:string)=>'/api/v1/forecast-journal/results/'+id;
test('protects ownership and query boundaries before any source request',async()=>{
 expect((await app.inject({url:path(requests[0]!)})).statusCode).toBe(401);
 expect((await app.inject({url:path(randomUUID()),headers:{cookie}})).statusCode).toBe(404);
 expect((await app.inject({url:path(requests[0]!)+'?ownerId='+randomUUID(),headers:{cookie}})).statusCode).toBe(400);
 expect(fetches).toBe(0);
});
test('deduplicates source fetch for recalculations and never creates canonical outcomes or rewrites forecasts',async()=>{
 const before=(await sql`SELECT prediction_id,snapshot_sha256 FROM v1_runtime_snapshots ORDER BY prediction_id`.execute(database.db)).rows;
 const results=await Promise.all(requests.map(requestId=>app.inject({url:path(requestId),headers:{cookie}})));
 for(const response of results){expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  expect(JournalResultSchema.parse(response.json())).toMatchObject({state:'finished',actualWinner:'B',correct:null,canonicalOutcome:false,reason:'NO_ISSUED_PROBABILITY'});
  expect(response.body).not.toContain(token);expect(response.body).not.toMatch(/password|snapshot_text|barrels/);
 }
 await app.inject({url:path(requests[0]!),headers:{cookie}});expect(fetches).toBe(1);
 expect((await sql`SELECT prediction_id,snapshot_sha256 FROM v1_runtime_snapshots ORDER BY prediction_id`.execute(database.db)).rows).toEqual(before);
 for(const table of ['v1_journal_reports','v1_forecast_outcome_revisions','v1_schedule_result_bindings'])expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);
});
test('terminal result survives service restart and corrections append receipts under shared cooldown',async()=>{
 const old=await sql`SELECT * FROM journal_provider_result_receipts`.execute(database.db);expect(old.rows).toHaveLength(1);
 const restart=new JournalResultService(database.db,token,async()=>{throw Error('must_not_fetch_terminal');});
 expect(await restart.read(ownerId,requests[0]!)).toMatchObject({state:'finished',actualWinner:'B'});
 expect(await restart.read(ownerId,requests[0]!,true)).toMatchObject({state:'finished',actualWinner:'B'});
 expect((await app.inject({method:'POST',url:path(requests[0]!)+'/refresh',headers:{cookie},payload:{}})).statusCode).toBe(403);
 // A new fetch is allowed only after the manual refresh cooldown; use an isolated synthetic clock.
 await sql`ALTER TABLE journal_provider_result_receipts DISABLE TRIGGER journal_provider_receipt_immutable`.execute(database.db);
 await sql`UPDATE journal_provider_result_receipts SET recorded_at=clock_timestamp()-interval '1 day'`.execute(database.db);
 await sql`ALTER TABLE journal_provider_result_receipts ENABLE TRIGGER journal_provider_receipt_immutable`.execute(database.db);
 expect(await new JournalResultService(database.db,token,async()=>{throw Error('unexpected_terminal_fetch');}).read(ownerId,requests[0]!)).toMatchObject({actualWinner:'B'});
 const refresh=await app.inject({method:'POST',url:path(requests[0]!)+'/refresh',headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{}});
 expect(refresh.statusCode).toBe(200);expect(fetches).toBe(2);
 expect(refresh.json()).toMatchObject({actualWinner:'A'});
 const independent=new JournalResultService(database.db,token,async()=>{throw Error('must_read_correction');});
 expect(await independent.read(ownerId,requests[1]!)).toMatchObject({actualWinner:'A'});
 expect((await sql`SELECT * FROM journal_provider_result_receipts`.execute(database.db)).rows).toHaveLength(2);
 await expect(sql`DELETE FROM journal_provider_result_receipts`.execute(database.db)).rejects.toThrow('immutable');
});
