import {randomBytes} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {HeroMatchupReportSchema} from '@dota/contracts';
import {sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedHeroPairs,pairInput} from '../../../tests/helpers/hero-matchups.js';
import {draftRule} from '../../../tests/helpers/draft.js';
import {policy} from '../../../packages/db/tests/patch-fixtures.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,id:string;
const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:path,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
const request=(query={})=>send(`/api/v1/scenarios/${id}/hero-matchups`,{expectedRevision:1,fromAt:'2024-01-01T00:00:00.000Z',...query});
beforeEach(async()=>{
  database=await testDatabase();await seedHeroPairs(database.db);const password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-pairs',password);app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-pairs',password}});
  const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=login.json().csrfToken;
  const saved=await send('/api/v1/scenarios',pairInput());expect(saved.statusCode).toBe(201);id=saved.json().id;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
test('owner, CSRF, revisions, catalogs and malformed requests are enforced',async()=>{
  const url=`/api/v1/scenarios/${id}/hero-matchups`;
  expect((await app.inject({method:'POST',url,payload:{expectedRevision:1}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie},payload:{expectedRevision:1}})).statusCode).toBe(403);
  expect((await request({expectedRevision:2})).statusCode).toBe(409);expect((await request({leagueId:'999999'})).statusCode).toBe(400);
  expect((await request({fromAt:'2024-01-03T00:00:00.000Z'})).statusCode).toBe(400);expect((await request({patchScope:'specific'})).statusCode).toBe(400);
  expect((await send('/api/v1/scenarios/00000000-0000-4000-8000-000000000999/hero-matchups',{expectedRevision:1})).statusCode).toBe(404);
});
test('raw map counts, native side wins and earlier empirical prior are reproducible without modifying snapshots',async()=>{
  const before=(await app.inject({url:`/api/v1/scenarios/${id}/history`,headers:{cookie}})).json();
  const response=await request();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const r=HeroMatchupReportSchema.parse(response.json());expect(r.allies).toHaveLength(2);expect(r.enemies).toHaveLength(4);
  expect(r.allies[0]).toMatchObject({nRaw:2,wins:1,winRate:0.5,smoothing:{status:'available',estimate:0.5,prior:{mass:2}},weighted:{status:'disabled',rate:null}});
  expect(r.enemies[0]).toMatchObject({nRaw:2,wins:1});expect(r.teamAWinProbability).toBeNull();expect(r.provenance.map(m=>m.matchId)).toEqual(['8001','8002']);
  expect((await request()).json().fingerprint).toBe(r.fingerprint);expect((await app.inject({url:`/api/v1/scenarios/${id}/history`,headers:{cookie}})).json()).toEqual(before);
  expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('partial draft and duplicate hero exclude only affected pair; unknown identity is irrelevant',async()=>{
  await sql`DELETE FROM match_players WHERE match_id=8001 AND player_slot=132`.execute(database.db);
  await sql`UPDATE match_players SET source_account_id=NULL,player_id=NULL WHERE match_id IN (8001,8002)`.execute(database.db);
  expect((await request()).json().allies[0].nRaw).toBe(2);
  await sql`UPDATE match_players SET hero_id=1 WHERE match_id=8001 AND player_slot=2`.execute(database.db);
  const r=(await request()).json();expect(r.allies[0].nRaw).toBe(1);expect(r.allies[1].nRaw).toBe(2);expect(r.coverage.invalidHeroRows).toBe(2);
});
test('PostgreSQL enforces strict start and completion at microsecond boundaries',async()=>{
  await sql`UPDATE matches SET started_at='2024-01-03T00:00:00Z' WHERE id=8002`.execute(database.db);
  expect((await request()).json().allies[0].nRaw).toBe(1);
  await sql`UPDATE matches SET started_at='2024-01-02T23:30:00.000001Z',duration_seconds=1800 WHERE id=8001`.execute(database.db);
  expect((await request()).json().allies[0]).toMatchObject({nRaw:0,winRate:null});
  await sql`UPDATE matches SET started_at='2024-01-02T23:30:00Z' WHERE id=8001`.execute(database.db);
  expect((await request()).json().allies[0].nRaw).toBe(1);
});
test('current patch unknown withholds filtered report; explicit weights require every hero proof',async()=>{
  const weights={version:policy.version,validation:policy.validation,draft:policy.draft};
  expect((await request({weights})).json().allies[0].weighted).toMatchObject({status:'unavailable',rate:null,nEff:null});
  for(const hero of [1,2,6,7])await draftRule(database.db,hero,true);
  const r=(await request({weights,patchScope:'current'})).json();expect(r.allies[0].weighted.status).toBe('computed_candidate');expect(r.allies[0].weighted.nEff).toBeGreaterThan(1);expect(r.allies[0].weighted.rate).toBeLessThan(0.5);
  expect(r.teamAWinProbability).toBeNull();
  const future=pairInput();future.cutoffAt='2025-06-01T00:00:00.000Z';future.scheduledAt=future.cutoffAt;const saved=await send('/api/v1/scenarios',future);expect(saved.statusCode).toBe(201);id=saved.json().id;
  expect((await request({patchScope:'current'})).json().reason).toBe('TARGET_PATCH_UNKNOWN');
});
test('reference overflow disables smoothing only; target overflow never returns truncated statistics',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro) SELECT n,'2023-06-01'::timestamptz,1800,true,true FROM generate_series(10000,15000) n`.execute(database.db);
  await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id) SELECT n,0,'radiant',1 FROM generate_series(10000,15000) n`.execute(database.db);
  const r=(await request()).json();expect(r.allies[0].nRaw).toBe(2);expect(r.reference.status).toBe('unavailable');
  await sql`UPDATE matches SET started_at='2024-01-01T01:00:00Z' WHERE id>=10000`.execute(database.db);
  expect((await request()).json().reason).toBe('WINDOW_TOO_LARGE');
});
