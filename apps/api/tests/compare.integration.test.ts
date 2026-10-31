import {randomBytes} from 'node:crypto';
import {beforeEach,afterEach,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {CompareReportSchema} from '@dota/contracts';
import {sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedCompare,compareInput} from '../../../tests/helpers/compare.js';
import {catalogPlayerId,catalogTeamId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string;
const url='/api/v1/teams/compare';
beforeEach(async()=>{
  database=await testDatabase();await seedCompare(database.db);const password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-compare',password);app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-compare',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
const post=(payload:unknown=compareInput())=>app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
test('owner/CSRF/no-store guard read-only comparison; raw H2H and historically rated opponents have separate evidence',async()=>{
  expect((await app.inject({method:'POST',url,payload:compareInput()})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173'},payload:compareInput()})).statusCode).toBe(403);
  const response=await post();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');const r=CompareReportSchema.parse(response.json());
  expect(r.teamA.organization).toMatchObject({nRaw:2,wins:1,winRate:0.5});expect(r.h2h.selectedFives.nRaw).toBe(2);expect(r.teamA.currentPatch?.nRaw).toBe(2);
  expect(r.teamA.strength.status).not.toBe('unavailable');if(r.teamA.strength.status!=='unavailable')expect(r.teamA.strength.summary).toMatchObject({ratedMaps:2,meanOpponentRatingBefore:1492});
  expect(r.teamAWinProbability).toBeNull();expect(r.h2h.maps.map(m=>m.teamASide)).toEqual(['dire','radiant']);
});
test('same organizations, duplicate cross-side players, malformed IDs, unknown players and future cutoff reject without precision loss',async()=>{
  const q=compareInput();for(const payload of [{...q,teamBId:q.teamAId},{...q,teamAId:'1e3'},{...q,cutoffAt:'2999-01-01T00:00:00.000Z'},
    {...q,lineupB:q.lineupA},{...q,lineupA:q.lineupA.map((p,i)=>i===4?{...p,playerId:'999999999'}:p)},{...q,teamAWinProbability:0.5}])expect((await post(payload)).statusCode).toBe(400);
  expect((await post({...q,teamBId:'999999999'})).statusCode).toBe(404);
});
test('replacement does not inherit old organization wins; unresolved manual five is unknown rather than zero',async()=>{
  const q=compareInput();q.lineupA[4]!.playerId=String(BigInt(catalogPlayerId)+10n);q.lineupA[4]!.isStandin=true;
  const r=CompareReportSchema.parse((await post(q)).json());expect(r.teamA.organization.nRaw).toBe(2);expect(r.teamA.selectedFiveOrganization).toMatchObject({nRaw:0,winRate:null});
  const unknown={...q,lineupA:q.lineupA.map(p=>({...p,playerId:null}))};expect(CompareReportSchema.parse((await post(unknown)).json()).h2h.selectedFives.nRaw).toBeNull();
});
test('cross-org history follows accounts without trusting cached IDs; organization H2H stays tag-scoped',async()=>{
  await sql`UPDATE matches SET radiant_team_id=9007199254740995 WHERE id=8001`.execute(database.db);
  await sql`UPDATE match_players SET player_id=NULL`.execute(database.db);
  const r=CompareReportSchema.parse((await post()).json());expect(r.teamA.organization.nRaw).toBe(1);expect(r.teamA.cohesion.actual.exactFive.nRaw).toBe(2);
  expect(r.h2h.organizations).toMatchObject({nRaw:1,wins:0});
});
test('SQL strict start/completion preserves microsecond cutoff; unknown target patch does not hide raw cohort',async()=>{
  const q=compareInput(),at='2024-01-02T12:30:00.000Z';
  await sql`UPDATE matches SET started_at='2024-01-02T12:00:00.000001Z' WHERE id=8002`.execute(database.db);
  const r=CompareReportSchema.parse((await post({...q,cutoffAt:at})).json());expect(r.h2h.organizations.nRaw).toBe(1);
  const unknown=CompareReportSchema.parse((await post({...q,cutoffAt:'2025-01-01T00:00:00.000Z'})).json());expect(unknown.currentPatchId).toBeNull();expect(unknown.teamA.currentPatch).toBeNull();expect(unknown.teamA.organization.nRaw).toBe(2);
});
test('global warmup overflow withholds strength independently of bounded raw display cohort',async()=>{
  await sql`INSERT INTO matches(id,started_at,is_pro) SELECT 100000+x,'2023-01-01'::timestamptz,false FROM generate_series(1,5001) x`.execute(database.db);
  const r=CompareReportSchema.parse((await post()).json());expect(r.teamA.organization.nRaw).toBe(2);expect(r.teamA.strength.status).toBe('unavailable');expect(r.teamB.strength.status).toBe('unavailable');
});
test('display window over 5000 candidates never returns truncated plausible statistics',async()=>{
  await sql`INSERT INTO matches(id,started_at,is_pro,radiant_team_id) SELECT 100000+x,'2024-01-01'::timestamptz,false,${catalogTeamId} FROM generate_series(1,5001) x`.execute(database.db);
  expect((await post()).json()).toMatchObject({status:'unavailable',reason:'WINDOW_TOO_LARGE'});
});
