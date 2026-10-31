import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PlayerHeroReportSchema,PlayerHeroResponseSchema} from '@dota/contracts';
import {IdentityRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedPlayerHeroes} from '../../../tests/helpers/player-hero.js';
import {catalogPlayerId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string;
beforeAll(async()=>{
  database=await testDatabase();await seedPlayerHeroes(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-player-hero',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-player-hero',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const route=`/api/v1/players/${catalogPlayerId}/heroes`;
const get=(extra='',path=route)=>app.inject({url:path+'?cutoffAt=2024-01-03T00:00:00.000Z'+(extra?'&'+extra:''),headers:{cookie}});
test('owner-only no-store report uses pro maps, role-aware grouping and per-metric actual denominators',async()=>{
  expect((await app.inject(route)).statusCode).toBe(401);
  const response=await get();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const r=PlayerHeroReportSchema.parse(response.json());expect(r.summary).toMatchObject({nRaw:2,wins:1,winRate:0.5,
    kda:{value:10,nMaps:1},meanKills:{value:7,nMaps:2},meanDeaths:{value:1,nMaps:2},meanAssists:{value:6,nMaps:1},
    meanGpm:{value:400,nMaps:1},meanXpm:{value:600,nMaps:1}});
  expect(r.groups.map(g=>g.rolePos)).toEqual([1,2]);expect(r.groups.every(g=>g.heroId==='1'&&g.heroName==='Synthetic Hero')).toBe(true);
  expect(r.effectivePatchId).toBe('1');expect(r.predictionEligibility).toBe('not_assessed');
  expect(Date.parse(r.cutoffAt)-Date.parse(r.fromAt)).toBe(90*86400000);
});
test('explicit role, native side, hero and patch filters preserve missing fields and nullable zero samples',async()=>{
  const first=PlayerHeroReportSchema.parse((await get('heroId=1&rolePos=1&side=radiant')).json());
  expect(first.summary.nRaw).toBe(1);expect(first.summary.meanXpm).toEqual({value:null,nMaps:0});
  const second=PlayerHeroReportSchema.parse((await get('rolePos=2&side=dire')).json());
  expect(second.summary).toMatchObject({nRaw:1,wins:0,kda:{value:null,nMaps:0},meanXpm:{value:600,nMaps:1}});
  for(const filter of ['heroId=9007199254740993','patchScope=specific&patchId=2','rolePos=5']){
    const empty=PlayerHeroReportSchema.parse((await get(filter)).json());expect(empty.summary).toMatchObject({nRaw:0,winRate:null});expect(empty.groups).toEqual([]);
  }
});
test('current patch uncertainty is unavailable; explicit all-patches choice works with a 90-day default',async()=>{
  const current=PlayerHeroResponseSchema.parse((await app.inject({url:route,headers:{cookie}})).json());
  expect(current).toMatchObject({status:'unavailable',reason:'CURRENT_PATCH_UNKNOWN'});
  const all=PlayerHeroReportSchema.parse((await app.inject({url:route+'?patchScope=all',headers:{cookie}})).json());
  expect(all.summary.nRaw).toBe(0);expect(all.filters.patchScope).toBe('all');
});
test('hero frequency denominator keeps other heroes, and source identity follows the player across tags',async()=>{
  await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES(11,'synthetic_hero_11','Synthetic Hero 11')`.execute(database.db);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
    VALUES(8201,'2024-01-03T12:00:00Z',1800,true,true,9007199254740995,9007199254740994)`.execute(database.db);
  await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id,kills,deaths,assists,gpm,xpm)
    SELECT 8201,player_slot,side,CASE WHEN player_slot=0 THEN 11 ELSE hero_id END,source_account_id,kills,deaths,assists,gpm,xpm FROM match_players WHERE match_id=8001`.execute(database.db);
  // Cached canonical projections are not the authority for statistics.
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=8001`.execute(database.db);
  const r=PlayerHeroReportSchema.parse((await app.inject({url:route+'?cutoffAt=2024-01-04T00:00:00.000Z&heroId=1',headers:{cookie}})).json());
  expect(r.summary.nRaw).toBe(2);expect(r.playerMapsInScope).toBe(3);expect(r.selectedHeroShare).toBeCloseTo(2/3);
  expect(r.groups[0]?.heroPickRate).toBeCloseTo(2/3);
  const other=PlayerHeroReportSchema.parse((await app.inject({url:route+'?cutoffAt=2024-01-04T00:00:00.000Z&heroId=11',headers:{cookie}})).json());
  expect(other.summary.nRaw).toBe(1);expect(other.groups[0]?.rolePos).toBeNull();expect(other.maps[0]?.organizationId).toBe('9007199254740995');
});
test('SQL strict start and completion at microsecond precision exclude unobserved outcomes',async()=>{
  const path=route+'?cutoffAt=2024-01-02T12:00:00.000Z';
  const before=PlayerHeroReportSchema.parse((await app.inject({url:path,headers:{cookie}})).json());expect(before.summary.nRaw).toBe(1);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro) VALUES(8202,'2024-01-02T11:30:00.000001Z',1800,true,true)`.execute(database.db);
  await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id) VALUES(8202,0,'radiant',1,1000)`.execute(database.db);
  const edge=PlayerHeroReportSchema.parse((await app.inject({url:path,headers:{cookie}})).json());
  expect(edge.summary.nRaw).toBe(1);expect(edge.coverage.unfinished).toBe(1);expect(edge.maps.some(m=>m.matchId==='8202')).toBe(false);
});
test('strict query returns structured 400 for malformed values and 404 for a missing canonical player',async()=>{
  for(const query of ['heroId=1e3','rolePos=6','patchScope=all&patchId=1','patchScope=specific','playerId=1','side=A',
    'cutoffAt=2999-01-01T00:00:00.000Z','fromAt=2999-01-01T00:00:00.000Z']){
    const r=await app.inject({url:route+'?'+query,headers:{cookie}});expect(r.statusCode,query).toBe(400);expect(r.json().error.code).toBe('VALIDATION_ERROR');
  }
  expect((await get('','/api/v1/players/999999/heroes')).statusCode).toBe(404);
});
test('conflicting verified links exclude attribution instead of filling metrics through cached IDs',async()=>{
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:String(BigInt(catalogPlayerId)+1n),externalAccountId:'1000',provider:'opendota',status:'verified',
    eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:conflict',source:'synthetic'});
  const r=PlayerHeroReportSchema.parse((await get()).json());expect(r.summary.nRaw).toBe(0);expect(r.coverage.identityUnresolved).toBeGreaterThan(0);
});
test('more than 5000 target candidate maps are unavailable without a plausible truncated sample',async()=>{
  await sql`INSERT INTO matches(id,started_at,is_pro,radiant_win,duration_seconds)
    SELECT 100000+n,'2025-01-01'::timestamptz,true,true,1800 FROM generate_series(1,5001) n`.execute(database.db);
  await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id,player_id)
    SELECT 100000+n,0,'radiant',1,1000,${catalogPlayerId}::bigint FROM generate_series(1,5001) n`.execute(database.db);
  const response=PlayerHeroResponseSchema.parse((await app.inject({url:route+'?patchScope=all&fromAt=2024-01-01T00:00:00.000Z&cutoffAt=2025-02-01T00:00:00.000Z',headers:{cookie}})).json());
  expect(response).toMatchObject({status:'unavailable',reason:'WINDOW_TOO_LARGE'});
});
