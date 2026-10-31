import {randomBytes} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {ScenarioReportSchema} from '@dota/contracts';
import {sql,ScenarioReportRepository} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedScenarioReports,reportInput} from '../../../tests/helpers/scenario-report.js';
import {draftRule} from '../../../tests/helpers/draft.js';
import {policy} from '../../../packages/db/tests/patch-fixtures.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,id:string,ownerId:string;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(path:string,payload:unknown)=>app.inject({method:'POST',url:path,headers:headers(),payload});
const create=(query={})=>post(`/api/v1/scenarios/${id}/analyses`,{expectedRevision:1,fromAt:'2024-01-01T00:00:00.000Z',...query});
const get=(path:string)=>app.inject({url:path,headers:{cookie}});
beforeEach(async()=>{
  database=await testDatabase();await seedScenarioReports(database.db);const password=randomBytes(24).toString('base64url');
  ownerId=(await new AuthService(database.db).provision('synthetic-reports',password)).id;app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-reports',password}});
  const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=login.json().csrfToken;
  const input=reportInput();input.expectedLineupA=structuredClone(input.lineupA);
  const saved=await post('/api/v1/scenarios',input);expect(saved.statusCode).toBe(201);id=saved.json().id;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
test('owner/CSRF, stale revision, strict filters and cross-owner access protect every report route',async()=>{
  const path=`/api/v1/scenarios/${id}/analyses`;
  expect((await app.inject({method:'POST',url:path,payload:{expectedRevision:1}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:path,headers:{cookie},payload:{expectedRevision:1}})).statusCode).toBe(403);
  expect((await create({expectedRevision:2})).statusCode).toBe(409);expect((await create({recordedAt:'2020-01-01T00:00:00.000Z'})).statusCode).toBe(400);
  expect((await create({leagueId:'99999'})).statusCode).toBe(400);expect((await create({fromAt:'2024-01-03T00:00:00.000Z'})).statusCode).toBe(400);
  const result=ScenarioReportSchema.parse((await create()).json());expect((await get(`/api/v1/analyses/${result.id}`)).headers['cache-control']).toBe('no-store');
  const other='00000000-0000-4000-8000-000000000999',repo=new ScenarioReportRepository(database.db);
  await expect(repo.get(other,result.id)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(repo.history(other,id)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(repo.create(other,id,{expectedRevision:1,patchScope:'all'})).rejects.toMatchObject({code:'NOT_FOUND'});
});
test('one snapshot combines raw organization, expected roster, role/hero metrics, pairs and independent cohorts',async()=>{
  const response=await create();expect(response.statusCode).toBe(201);const r=ScenarioReportSchema.parse(response.json());
  expect(r.version).toBe(1);expect(r.report.comparison.teamA.organization).toMatchObject({nRaw:2,winRate:0.5});
  expect(r.report.comparison.teamA.cohesion.expected).not.toBeNull();expect(r.report.comparison.teamB.cohesion.expected).toBeNull();
  expect(r.report.players).toHaveLength(10);expect(r.report.players[0]?.report).toMatchObject({status:'ready',summary:{nRaw:2,winRate:0.5,kda:{value:10,nMaps:1},meanXpm:{value:null,nMaps:0}}});
  expect(r.report.pairs).toMatchObject({status:'ready',allies:[{nRaw:2,winRate:0.5},{}]});expect(r.report.scenario.input.context.radiantSlot).toBeNull();
  expect(r.report.lineupEvidence.historicalAvailability).toBe('unverified');expect(r.report.prediction.teamAWinProbability).toBeNull();
  expect(r.report.heroMeta[0]).toMatchObject({heroId:1,nRaw:2,winRate:0.5,knownDraftPicks:2,completeDraftMaps:2,pickRate:1});
  expect(r.report.provenance.maps.filter(m=>m.included).map(m=>m.matchId).sort()).toEqual(['8001','8002']);
  expect(r.report.players.every(p=>p.report.cutoffAt===r.report.cutoffAt&&p.report.snapshotAt===r.report.snapshotAt)).toBe(true);
  expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('source corrections and scenario edits create new versions without changing old results or input',async()=>{
  const first=ScenarioReportSchema.parse((await create()).json());await sql`UPDATE matches SET radiant_win=false,data_revision=data_revision+1 WHERE id=8001`.execute(database.db);
  const second=ScenarioReportSchema.parse((await create()).json());expect(second.version).toBe(2);expect(second.resultHash).not.toBe(first.resultHash);
  expect((await get(`/api/v1/analyses/${first.id}`)).json()).toEqual(first);
  const q=reportInput();q.context.radiantSlot='B';q.draft!.assignments[0]!.heroId=3;
  expect((await app.inject({method:'PUT',url:`/api/v1/scenarios/${id}`,headers:headers(),payload:{expectedRevision:1,input:q}})).statusCode).toBe(200);
  expect((await create()).statusCode).toBe(409);const third=ScenarioReportSchema.parse((await create({expectedRevision:2})).json());expect(third.version).toBe(3);
  expect(third.report.players[0]?.report.filters.side).toBe('dire');expect(third.report.players[0]?.heroId).toBe(3);
  expect((await get(`/api/v1/analyses/${first.id}`)).json()).toEqual(first);
  const history=(await get(`/api/v1/scenarios/${id}/analyses`)).json();expect(history.items.map((v:{version:number})=>v.version)).toEqual([3,2,1]);expect(history.items[2].scenarioRevision).toBe(1);
});
test('database forbids rewriting/deleting terminal reports, forged input, and upgrading legacy job rows',async()=>{
  const r=ScenarioReportSchema.parse((await create()).json());
  await expect(sql`UPDATE analysis_runs SET warnings='[]' WHERE id=${r.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`DELETE FROM analysis_runs WHERE id=${r.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`INSERT INTO analysis_runs(scenario_id,scenario_revision,report_version,input_hash,data_revision,algorithm_version,status,result,computed_at,result_hash)
    SELECT scenario_id,scenario_revision,99,input_hash,data_revision,algorithm_version,status,jsonb_set(result,'{scenario,input,title}','"forged"'),computed_at,result_hash FROM analysis_runs WHERE id=${r.id}::uuid`.execute(database.db)).rejects.toThrow('frozen scenario');
  const legacy=(await sql<{id:string}>`INSERT INTO analysis_runs(scenario_id,input_hash,data_revision,algorithm_version) VALUES(${id}::uuid,${'0'.repeat(64)},'synthetic','legacy') RETURNING id`.execute(database.db)).rows[0]!;
  await sql`UPDATE analysis_runs SET status='running' WHERE id=${legacy.id}::uuid`.execute(database.db);
  expect((await get(`/api/v1/analyses/${legacy.id}`)).statusCode).toBe(404);
  await expect(sql`UPDATE analysis_runs SET report_version=99 WHERE id=${legacy.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
});
test('concurrent calculations allocate unique versions and leave scenario revision unchanged',async()=>{
  const rows=await Promise.all([create(),create()]);expect(rows.map(r=>r.statusCode)).toEqual([201,201]);expect(rows.map(r=>r.json().version).sort()).toEqual([1,2]);
  expect((await get(`/api/v1/scenarios/${id}`)).json().revision).toBe(1);
  expect((await get(`/api/v1/scenarios/${id}/analyses?offset=1`)).json().items.map((r:{version:number})=>r.version)).toEqual([1]);
  expect((await get(`/api/v1/scenarios/${id}/analyses?offset=-1`)).statusCode).toBe(400);
});
test('current patch and global target overflow never persist a misleading partial report',async()=>{
  const q=reportInput();q.cutoffAt='2025-06-01T00:00:00.000Z';q.scheduledAt=q.cutoffAt;const future=await post('/api/v1/scenarios',q),old=id;id=future.json().id;
  expect((await create({patchScope:'current'})).json().reason).toBe('TARGET_PATCH_UNKNOWN');id=old;
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro) SELECT n,'2024-01-01T01:00:00Z'::timestamptz,1800,true,true FROM generate_series(10000,15000) n`.execute(database.db);
  expect((await create()).json().reason).toBe('WINDOW_TOO_LARGE');expect((await get(`/api/v1/scenarios/${id}/analyses`)).json().items).toHaveLength(0);
});
test('reference and strength overflow preserve raw target metrics and explicit unavailable sections',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro) SELECT n,'2023-01-01'::timestamptz,1800,true,true FROM generate_series(10000,15000) n`.execute(database.db);
  const r=ScenarioReportSchema.parse((await create()).json()).report;expect(r.comparison.teamA.organization.nRaw).toBe(2);expect(r.comparison.teamA.strength.status).toBe('unavailable');
  expect(r.provenance.referenceStatus).toBe('unavailable');expect(r.players[0]?.report).toMatchObject({summary:{nRaw:2},smoothing:{status:'unavailable'}});
});
test('explicit candidate weights freeze separately from raw WR and SQL microseconds still apply',async()=>{
  for(const hero of [1,2,6,7])await draftRule(database.db,hero,true);
  const weights={version:policy.version,validation:policy.validation,draft:policy.draft};
  const r=ScenarioReportSchema.parse((await create({weights})).json()).report;expect(r.pairs).toMatchObject({allies:[{winRate:0.5,weighted:{status:'computed_candidate'}},{}]});
  await sql`UPDATE matches SET started_at='2024-01-03'::timestamptz WHERE id=8002`.execute(database.db);
  await sql`UPDATE matches SET started_at='2024-01-02T23:30:00.000001Z',duration_seconds=1800 WHERE id=8001`.execute(database.db);
  const zero=ScenarioReportSchema.parse((await create()).json()).report;expect(zero.comparison.teamA.organization).toMatchObject({nRaw:0,winRate:null});expect(zero.pairs).toMatchObject({status:'insufficient_data'});
});
test('reference-only corrections invalidate source revision while target raw metrics and saved old report remain unchanged',async()=>{
  const first=ScenarioReportSchema.parse((await create()).json());
  const before=(await sql<{data_revision:string}>`SELECT data_revision FROM analysis_runs WHERE id=${first.id}::uuid`.execute(database.db)).rows[0]!.data_revision;
  await sql`UPDATE matches SET radiant_win=false,data_revision=data_revision+1 WHERE id=8031`.execute(database.db);
  const second=ScenarioReportSchema.parse((await create()).json());
  const after=(await sql<{data_revision:string}>`SELECT data_revision FROM analysis_runs WHERE id=${second.id}::uuid`.execute(database.db)).rows[0]!.data_revision;
  expect(second.report.comparison.teamA.organization).toEqual(first.report.comparison.teamA.organization);expect(after).not.toBe(before);
  expect(second.report.provenance.referenceFingerprint).not.toBe(first.report.provenance.referenceFingerprint);
  expect((await get(`/api/v1/analyses/${first.id}`)).json()).toEqual(first);
});
