import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {ProMapReportSchema,ProMapResponseSchema} from '@dota/contracts';
import {sql,IdentityRepository} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedProMaps} from '../../../tests/helpers/pro-maps.js';
import {catalogTeamId,catalogPlayerId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string;
beforeAll(async()=>{
  database=await testDatabase();await seedProMaps(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-pro-maps',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-pro-maps',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const path=`/api/v1/teams/${catalogTeamId}/matches`;
const get=(query='',route=path)=>app.inject({url:route+(query?'?'+query:''),headers:{cookie}});
test('pro-map endpoints require owner auth and return no-store independent map outcomes',async()=>{
  expect((await app.inject(path)).statusCode).toBe(401);
  const response=await get();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const r=ProMapReportSchema.parse(response.json());expect(r.summary).toMatchObject({nRaw:2,wins:1,losses:1,winRate:0.5});
  expect(r.coverage).toMatchObject({candidates:4,unknownPro:1,nonPro:1,completeCanonicalRosters:2,knownSeries:0,knownPatch:2});
  expect(r.maps.map(m=>m.side)).toEqual(['dire','radiant']);expect(r.maps.every(m=>m.patchId==='1')).toBe(true);
  expect(r.maps.every(m=>m.rolePos===null)).toBe(true);expect(r.scope).toBe('retrospective_descriptive');
});
test('filters apply before last N and preserve effective UTC bounds, opponent and role meaning',async()=>{
  const r=ProMapReportSchema.parse((await get('fromAt=2024-01-02T00:00:00.000Z&cutoffAt=2024-01-03T00:00:00.000Z&side=dire&patchId=1&opponentId=9007199254740994')).json());
  expect(r.summary.nRaw).toBe(1);expect(r.summary.winRate).toBe(0);expect(r.maps[0]?.matchId).toBe('8002');
  const role=ProMapReportSchema.parse((await get('playerId='+catalogPlayerId+'&rolePos=1')).json());
  expect(role.summary.nRaw).toBe(2);expect(role.coverage.confirmedTargetRole).toBe(2);expect(role.maps[0]?.roleProofIds.length).toBe(1);
  expect(ProMapReportSchema.parse((await get('patchId=2')).json()).summary.winRate).toBeNull();
});
test('strict start cutoff and SQL completion including a future microsecond prevent outcome inclusion',async()=>{
  const before=ProMapReportSchema.parse((await get('cutoffAt=2024-01-02T12:00:00.000Z')).json());
  expect(before.summary.nRaw).toBe(1);expect(before.maps[0]?.matchId).toBe('8001');
  const during=ProMapReportSchema.parse((await get('cutoffAt=2024-01-02T12:15:00.000Z')).json());
  expect(during.coverage.unfinished).toBe(1);expect(during.summary.nRaw).toBe(1);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id)
    VALUES(8100,'2024-01-02T11:30:00.000001Z',1800,true,true,${catalogTeamId})`.execute(database.db);
  const edge=ProMapReportSchema.parse((await get('cutoffAt=2024-01-02T12:00:00.000Z')).json());
  expect(edge.maps.some(m=>m.matchId==='8100')).toBe(false);expect(edge.coverage.unfinished).toBe(1);
});
test('unknown opponent, roster and series stay independent from a known organization map outcome',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id)
    VALUES(8101,'2024-02-01T12:00:00Z',1800,true,true,${catalogTeamId})`.execute(database.db);
  const r=ProMapReportSchema.parse((await get()).json());const m=r.maps.find(m=>m.matchId==='8101');
  expect(m).toMatchObject({opponentId:null,seriesId:null,completeCanonicalRoster:false,won:true});
  expect(r.coverage.unattributedOrganizationMapsInWindow).toBeGreaterThanOrEqual(1);
  const zero=ProMapReportSchema.parse((await get('leagueId=99')).json());expect(zero.summary).toMatchObject({nRaw:0,winRate:null,meanDurationSeconds:null});
});
test('player history is read through verified source accounts rather than stored canonical projections',async()=>{
  const route=`/api/v1/players/${catalogPlayerId}/matches`;
  const r=ProMapReportSchema.parse((await get('rolePos=1',route)).json());expect(r.summary.nRaw).toBe(2);expect(r.maps[0]?.identityProofIds.length).toBe(10);
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:'9007199254741011',externalAccountId:'1000',provider:'opendota',
    status:'verified',eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:conflicting-identity',source:'synthetic'});
  const disputed=ProMapReportSchema.parse((await get('',route)).json());expect(disputed.summary.nRaw).toBe(0);expect(disputed.coverage.identityUnresolved).toBe(2);
  expect(ProMapReportSchema.parse((await get()).json()).summary.nRaw).toBeGreaterThanOrEqual(2);
});
test('future/invalid windows, role without target and malformed bigint return structured 400; missing entity is 404',async()=>{
  for(const query of ['cutoffAt=2999-01-01T00:00:00.000Z','fromAt=2025-01-01T00:00:00.000Z&cutoffAt=2024-01-01T00:00:00.000Z',
    'rolePos=1','rolePos=0','limit=1','side=A','patchId=1e3','extra=true','opponentId='+catalogTeamId]){
    const r=await get(query);expect(r.statusCode,query).toBe(400);expect(r.json().error.code).toBe('VALIDATION_ERROR');
  }
  expect((await get('','/api/v1/players/999999/matches')).statusCode).toBe(404);
});
test('oversized candidate windows are unavailable and never silently truncated into a plausible rate',async()=>{
  await sql`INSERT INTO matches(id,started_at,is_pro,radiant_win,duration_seconds,radiant_team_id)
    SELECT 100000+n,'2025-01-01'::timestamptz,true,true,1800,${catalogTeamId}::bigint FROM generate_series(1,5001) n`.execute(database.db);
  const response=ProMapResponseSchema.parse((await get()).json());expect(response).toMatchObject({status:'unavailable',reason:'WINDOW_TOO_LARGE',maxCandidates:5000});
});
