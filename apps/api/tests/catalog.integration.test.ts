import { randomBytes } from 'node:crypto';
import { afterAll,beforeAll,expect,test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CatalogListSchema,TeamOverviewSchema,PlayerOverviewSchema } from '@dota/contracts';
import { sql } from '@dota/db';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { seedCatalog,catalogTeamId,catalogPlayerId } from '../../../tests/helpers/catalog.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { AuthService } from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>, app:FastifyInstance, cookie:string;
beforeAll(async()=>{
  database=await testDatabase();await seedCatalog(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-catalog',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-catalog',password}});
  expect(login.statusCode).toBe(200);
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const get=(path:string)=>app.inject({url:'/api/v1/'+path,headers:{cookie}});
test('all catalogue routes require owner auth and never cache private responses',async()=>{
  for(const path of ['teams','players','heroes',`teams/${catalogTeamId}`,`players/${catalogPlayerId}`]) {
    expect((await app.inject('/api/v1/'+path)).statusCode).toBe(401);
    expect((await get(path)).headers['cache-control']).toBe('no-store');
  }
});
test('search distinguishes duplicate names by bigint IDs and tag; pagination does not duplicate rows',async()=>{
  const first=CatalogListSchema.parse((await get('teams?query=aurora&limit=1')).json());
  const second=CatalogListSchema.parse((await get('teams?query=aurora&limit=1&offset=1')).json());
  expect(first.hasMore).toBe(true);expect(second.hasMore).toBe(false);
  expect(first.items[0]?.id).toBe(catalogTeamId);expect(second.items[0]?.id).toBe('9007199254740994');
  expect(first.items[0]?.syncedAt).toBe('2024-01-02T00:00:00.000Z');expect(second.items[0]?.syncedAt).toBeNull();
  expect(CatalogListSchema.parse((await get('teams?query=SYN')).json()).items).toHaveLength(2);
  expect(CatalogListSchema.parse((await get('teams?query='+catalogTeamId)).json()).items[0]?.id).toBe(catalogTeamId);
});
test('literal wildcard/injection text, zero results and heroes preserve search semantics and unknown freshness',async()=>{
  expect(CatalogListSchema.parse((await get('teams?query=%25_')).json()).items).toHaveLength(1);
  const empty=CatalogListSchema.parse((await get('players?query='+encodeURIComponent("' OR 1=1 --"))).json());
  expect(empty.items).toEqual([]);expect(empty.hasMore).toBe(false);
  const heroes=CatalogListSchema.parse((await get('heroes?query=synthetic_hero')).json());
  expect(heroes.items[0]?.id).toBe('1');expect(heroes.items[0]?.syncedAt).toBeNull();
  const twins=CatalogListSchema.parse((await get('players?query=Twin')).json());
  expect(twins.items.map(p=>p.id)).toEqual([catalogPlayerId,'9007199254741011']);
});
test('invalid query/IDs yield structured 400 and unknown entities 404 without internal details',async()=>{
  for(const path of ['teams?limit=101','heroes?limit=abc','players?offset=-1','teams?extra=1','teams?query='+('a'.repeat(81)),
    'teams/9223372036854775808','players/0','teams/1e3']) {
    const r=await get(path);expect(r.statusCode,path).toBe(400);expect(r.json().error.code).toBe('VALIDATION_ERROR');
  }
  expect((await get('teams/999')).statusCode).toBe(404);expect((await get('players/999')).statusCode).toBe(404);
});
test('organization overview uses latest completed pro map native side, never current-members flags',async()=>{
  const result=TeamOverviewSchema.parse((await get('teams/'+catalogTeamId)).json());
  expect(result.currentLineup).toBeNull();expect(result.entityType).toBe('organization');
  expect(result.latestObservedLineup).toMatchObject({matchId:'8002',side:'dire',status:'complete'});
  expect(result.latestObservedLineup?.members.map(p=>p.playerSlot)).toEqual([128,129,130,131,132]);
  expect(result.latestObservedLineup?.members.map(p=>p.playerId)).not.toContain('9007199254741015');
  expect(result.warnings).toContain('OBSERVED_LINEUP_IS_NOT_PREMATCH_EVIDENCE');
  expect(TeamOverviewSchema.parse((await get('teams/9007199254740995')).json()).latestObservedLineup).toBeNull();
});
test('future/unfinished/conflicting maps cannot replace latest pro observation; partial IDs remain unknown',async()=>{
  for(const [id,started,duration,winner,state] of [['8010','2999-01-01T00:00:00Z',1800,true,'partial'],
    ['8011',new Date(Date.now()-1000).toISOString(),3600,true,'partial'],['8012','2024-02-01T00:00:00Z',1800,null,'partial'],
    ['8013','2024-03-01T00:00:00Z',1800,true,'conflict']] as const)
    await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,dire_team_id,ingest_state)
      VALUES(${id},${started},${duration},${winner},true,${catalogTeamId},${state})`.execute(database.db);
  expect(TeamOverviewSchema.parse((await get('teams/'+catalogTeamId)).json()).latestObservedLineup?.matchId).toBe('8002');
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=8002 AND player_slot=130`.execute(database.db);
  const result=TeamOverviewSchema.parse((await get('teams/'+catalogTeamId)).json());
  expect(result.latestObservedLineup?.status).toBe('incomplete');expect(result.latestObservedLineup?.members[2]?.playerId).toBeNull();
});
test('player catalogue never asserts verified account, team or public-match statistics',async()=>{
  const result=PlayerOverviewSchema.parse((await get('players/'+catalogPlayerId)).json());
  expect(result).toMatchObject({entityType:'canonical_player',catalogAccountId:'1000',accountVerification:'not_assessed',currentTeam:null});
  expect(JSON.stringify(result)).not.toMatch(/winRate|probability|games|password|tokenHash/);
});
