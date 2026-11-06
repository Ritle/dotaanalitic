import {randomBytes,randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {Tier1ScopeRepository,ScenarioRepository,PageScheduledPredictionService,V1PredictionService,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedPredictionScenario} from '../../../tests/helpers/predictions.js';
import {registryHash,registrySha} from '../../../packages/db/src/v1-registry.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,owner:string,cookie:string,csrf:string;
const scope={provider:'opendota',leagueId:'77',eventName:'Synthetic reviewed main event',fromAt:'2099-01-01T00:00:00.000Z',until:'2099-02-01T00:00:00.000Z',
 tier:1,stage:'main_event',sourceUrl:'https://example.test/synthetic-review',rationale:'Synthetic owner-reviewed event scope for testing only'};
const body=()=>({requestId:randomUUID(),scopeId:randomUUID(),expectedRevision:0,enabled:true,scope});
const post=(payload:unknown)=>app.inject({method:'POST',url:'/api/v1/tier1-scopes',headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
const get=(query='')=>app.inject({url:'/api/v1/tier1-scopes'+query,headers:{cookie}});
beforeEach(async()=>{
 database=await testDatabase();await seedPredictionScenario(database.db);const password=randomBytes(24).toString('base64url');
 owner=(await new AuthService(database.db).provision('synthetic-scope-owner',password)).id;
 app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-scope-owner',password}});
 const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(x=>x.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
test('protects owner/CSRF and validates the source, event scope and query boundaries',async()=>{
 expect((await app.inject({url:'/api/v1/tier1-scopes'})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/api/v1/tier1-scopes',headers:{cookie},payload:body()})).statusCode).toBe(403);
 for(const extra of [{ownerId:owner},{probability:0.8},{knownAt:'2020-01-01'}])expect((await post({...body(),...extra})).statusCode).toBe(400);
 for(const patch of [{tier:2},{stage:'qualifier'},{sourceUrl:'http://example.test'},{until:scope.fromAt}])expect((await post({...body(),scope:{...scope,...patch}})).statusCode).toBe(400);
 for(const q of ['?offset=-1','?ownerId=x','?localLeagueId=077'])expect((await get(q)).statusCode).toBe(400);
});
test('saves exact retries, resolves only canonical OpenDota IDs and hides through immutable revision',async()=>{
 const req=body(),first=await post(req);expect(first.statusCode,first.body).toBe(200);const record=first.json();
 expect(first.headers['cache-control']).toBe('no-store');expect(first.body).not.toContain(owner);
 expect((await post(req)).json()).toEqual(record);
 expect((await get('?localLeagueId=77&at=2099-01-02T00%3A00%3A00.000Z')).json()).toMatchObject({context:{localLeagueId:'77',providerLeagueId:'77'},items:[record]});
 expect((await get('?localLeagueId=999')).json().context.providerLeagueId).toBeNull();
 const hidden={...req,requestId:randomUUID(),expectedRevision:1,enabled:false};expect((await post(hidden)).statusCode).toBe(200);
 expect((await get()).json().items).toEqual([]);expect((await post(req)).json()).toEqual(record);
 expect((await sql`SELECT * FROM owner_tier1_scopes`.execute(database.db)).rows).toHaveLength(2);
 for(const q of [sql`UPDATE owner_tier1_scopes SET enabled=true`,sql`DELETE FROM owner_tier1_scopes`,sql`TRUNCATE owner_tier1_scopes`])await expect(q.execute(database.db)).rejects.toThrow();
 expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('serializes concurrent writes, checks CAS/request identity and isolates owner lists',async()=>{
 const repo=new Tier1ScopeRepository(database.db),req=body();const [a,b]=await Promise.all([repo.write(owner,req),repo.write(owner,req)]);expect(a).toEqual(b);
 await expect(repo.write(owner,{...req,enabled:false})).rejects.toThrow('tier1_scope_request_conflict');
 await expect(repo.write(owner,{...req,requestId:randomUUID()})).rejects.toThrow('CONFLICT');
 await expect(repo.write(owner,{...req,requestId:randomUUID(),expectedRevision:1,scope:{...scope,leagueId:'88'}})).rejects.toThrow('tier1_scope_new_league');
 expect((await repo.list(randomUUID(),{})).items).toEqual([]);
 const requests=[true,false].map(enabled=>({...req,requestId:randomUUID(),expectedRevision:1,enabled}));
 const results=await Promise.allSettled(requests.map(r=>repo.write(owner,r)));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
});
test('pages latest active editions without external provider calls or implicit tier inference',async()=>{
 const repo=new Tier1ScopeRepository(database.db);
 for(let i=0;i<21;i++)await repo.write(owner,{...body(),scope:{...scope,eventName:'Synthetic edition '+i}});
 const first=(await get()).json(),second=(await get('?offset=20')).json();expect(first.items).toHaveLength(20);expect(first.hasMore).toBe(true);expect(second.items).toHaveLength(1);
 expect(new Set([...first.items,...second.items].map(x=>x.record.request.scopeId)).size).toBe(21);
 expect((await sql`SELECT * FROM upcoming_source_observations`.execute(database.db)).rows).toHaveLength(0);
});
test('hiding a catalogue entry preserves copied forecast scope and still requires an active validated model',async()=>{
 const repo=new Tier1ScopeRepository(database.db),req=body(),entry=await repo.write(owner,req);
 const input=await (async()=>{const {runtimeFixture}=await import('../../../packages/db/tests/v1-runtime-fixtures.js');return runtimeFixture().input;})();
 const scenario=await new ScenarioRepository(database.db).save(owner,input),service=await PageScheduledPredictionService.open(database.db,await V1PredictionService.open(database.db));
 const forecast=await service.create(owner,{requestId:randomUUID(),scenarioId:scenario.id,expectedRevision:1,purpose:'what_if_single_map',targetScope:entry.record.request.scope});
 expect(forecast.status).toBe('unavailable');expect(forecast.teamAWinProbability).toBeNull();expect(forecast.reasons).toContain('NO_ACTIVE_MODEL');
 const before=(await sql`SELECT snapshot_text,snapshot_sha256 FROM v1_runtime_snapshots`.execute(database.db)).rows;
 await repo.write(owner,{...req,requestId:randomUUID(),expectedRevision:1,enabled:false});
 expect((await sql`SELECT snapshot_text,snapshot_sha256 FROM v1_runtime_snapshots`.execute(database.db)).rows).toEqual(before);
 expect((await service.get(owner,scenario.id,forecast.requestId)).targetScope).toEqual(scope);
});
test('SQL guards revision/source binding independently of the UI',async()=>{
 const request=body();
 await expect(database.db.transaction().execute(async tx=>{
  const at=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`.execute(tx)).rows[0]!.at;
  const bad={...request,scope:{...scope,tier:2}},text=JSON.stringify({format:'owner-tier1-scope-v1',request:bad,revision:1,previousSha256:null,recordedAt:at});
  await sql`INSERT INTO owner_tier1_scopes(owner_user_id,scope_id,revision,request_id,request_hash,enabled,record_text,record_sha256)
   VALUES(${owner},${request.scopeId},1,${request.requestId},${registryHash(bad)},true,${text},${registrySha(text)})`.execute(tx);
 })).rejects.toThrow('tier1_scope_record_binding');
});
