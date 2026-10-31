import {randomBytes,randomUUID} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {ScenarioSnapshotSchema} from '@dota/contracts';
import {sql,ScenarioRepository,ScenarioError} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedStrength} from '../../../tests/helpers/strength.js';
import {scenarioInput} from '../../../tests/helpers/scenario.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,owner:string;
const url='/api/v1/scenarios';
beforeEach(async()=>{
  database=await testDatabase();await seedStrength(database.db);const password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-scenario',password);app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-scenario',password}});
  const c=r.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=r.json().csrfToken;owner=r.json().owner.id;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
const send=(method:'POST'|'PUT',path=url,payload:unknown=scenarioInput())=>app.inject({method,url:path,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
const get=(path:string)=>app.inject({method:'GET',url:path,headers:{cookie}});
test('protected creation/read/history/list, exact confirmed ten, server clock and unknown context',async()=>{
  expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173'},payload:scenarioInput()})).statusCode).toBe(403);
  const before=Date.now(),r=await send('POST');expect(r.statusCode).toBe(201);expect(r.headers['cache-control']).toBe('no-store');
  const s=ScenarioSnapshotSchema.parse(r.json());expect(Date.parse(s.recordedAt)).toBeGreaterThanOrEqual(before);expect(s.knownAt).toBe(s.recordedAt);
  expect(s).toMatchObject({revision:1,eventAt:null,warnings:['OWNER_ASSERTION_ONLY','RECORDED_AFTER_CUTOFF'],predictionEligibility:'not_assessed'});
  expect((await get(`${url}/${s.id}`)).json()).toEqual(s);expect((await get(url)).json().items).toEqual([s]);expect((await get(`${url}/${s.id}/history`)).json().items).toEqual([s]);
  const lines=await sql<{n:string}>`SELECT count(*)::text n FROM scenario_lineup WHERE scenario_id=${s.id}::uuid`.execute(database.db);expect(lines.rows[0]?.n).toBe('10');
  expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('revision update freezes original, applies baseline and stand-in, normalizes array order',async()=>{
  const original=ScenarioSnapshotSchema.parse((await send('POST')).json()),q=scenarioInput();q.lineupA.reverse();q.lineupA[0]!.isStandin=true;q.expectedLineupA=scenarioInput().lineupA;q.title='Edited';
  q.context.radiantSlot='B';q.context.firstPickSlot='A';
  const changed=await send('PUT',`${url}/${original.id}`,{expectedRevision:1,input:q});expect(changed.statusCode).toBe(200);
  const s=ScenarioSnapshotSchema.parse(changed.json());expect(s.revision).toBe(2);expect(s.input.lineupA.map(p=>p.rolePos)).toEqual([1,2,3,4,5]);expect(s.inputHash).not.toBe(original.inputHash);
  const h=(await get(`${url}/${s.id}/history`)).json();expect(h.items[1]).toEqual(original);expect(h.items[0]).toEqual(s);
  expect((await sql`SELECT * FROM scenario_expected_lineup WHERE scenario_id=${s.id}::uuid`.execute(database.db)).rows).toHaveLength(5);
  expect((await send('PUT',`${url}/${s.id}`,{expectedRevision:2,input:scenarioInput()})).statusCode).toBe(200);
  expect((await sql`SELECT * FROM scenario_expected_lineup`.execute(database.db)).rows).toHaveLength(0);
});
test('two concurrent edits have exactly one winner and no partial loser; stale revision and missing revision reject',async()=>{
  const s=(await send('POST')).json();const q=scenarioInput();
  const responses=await Promise.all([send('PUT',`${url}/${s.id}`,{expectedRevision:1,input:{...q,title:'one'}}),send('PUT',`${url}/${s.id}`,{expectedRevision:1,input:{...q,title:'two'}})]);
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);expect((await get(`${url}/${s.id}/history`)).json().items).toHaveLength(2);
  expect((await send('PUT',`${url}/${s.id}`,{input:q})).statusCode).toBe(400);
});
test('unknown catalog, duplicate players and forged clocks reject atomically; invalid update leaves revision intact',async()=>{
  const q=scenarioInput();q.lineupA[0]!.playerId='9223372036854775807';expect((await send('POST',url,q)).statusCode).toBe(400);
  expect((await send('POST',url,{...scenarioInput(),knownAt:'2020-01-01T00:00:00.000Z'})).statusCode).toBe(400);
  const s=(await send('POST')).json();expect((await send('PUT',`${url}/${s.id}`,{expectedRevision:1,input:q})).statusCode).toBe(400);
  expect((await get(`${url}/${s.id}`)).json().revision).toBe(1);expect((await get(url)).json().items).toHaveLength(1);
});
test('no cross-owner access; missing/invalid ID and pagination are structured errors',async()=>{
  const s=(await send('POST')).json(),other=randomUUID();const repo=new ScenarioRepository(database.db);
  for(const op of [()=>repo.get(other,s.id),()=>repo.history(other,s.id),()=>repo.save(other,scenarioInput(),{id:s.id,expectedRevision:1})])await expect(op()).rejects.toBeInstanceOf(ScenarioError);
  expect((await repo.list(other)).items).toHaveLength(0);
  expect((await get(`${url}/${randomUUID()}`)).statusCode).toBe(404);expect((await get(`${url}/invalid`)).statusCode).toBe(400);expect((await get(`${url}?offset=-1`)).statusCode).toBe(400);
});
test('linked series uses same two organizations in either order and valid single-map score',async()=>{
  const q=scenarioInput(),series=randomUUID();
  await sql`INSERT INTO series(id,team_a_id,team_b_id,best_of) VALUES (${series}::uuid,${q.teamBId}::bigint,${q.teamAId}::bigint,3)`.execute(database.db);
  q.context={...q.context,seriesId:series,mapNumber:2,teamASeriesWinsBefore:1,teamBSeriesWinsBefore:0,radiantSlot:'B',firstPickSlot:'A'};
  const r=await send('POST',url,q);expect(r.statusCode).toBe(201);expect(r.json().input.context).toEqual(q.context);
  q.context.mapNumber=4;q.context.teamASeriesWinsBefore=2;q.context.teamBSeriesWinsBefore=1;expect((await send('POST',url,q)).statusCode).toBe(400);
  q.context.seriesId=randomUUID();expect((await send('POST',url,q)).statusCode).toBe(400);
});
test('DB forbids mutation/deletion of a stored input; recorded_at cannot be forged',async()=>{
  const s=(await send('POST')).json();
  await expect(sql`UPDATE scenario_input_snapshots SET input_snapshot='{}' WHERE scenario_id=${s.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`DELETE FROM scenario_input_snapshots WHERE scenario_id=${s.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  const before=Date.now();await sql`UPDATE scenarios SET revision=2 WHERE id=${s.id}::uuid`.execute(database.db);
  await sql`INSERT INTO scenario_input_snapshots(scenario_id,revision,input_snapshot,input_hash,recorded_at)
    VALUES (${s.id}::uuid,2,${JSON.stringify(s.input)}::jsonb,${s.inputHash},'2000-01-01')`.execute(database.db);
  expect(Date.parse((await get(`${url}/${s.id}`)).json().recordedAt)).toBeGreaterThanOrEqual(before);
});
