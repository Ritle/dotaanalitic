import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {RosterReportSchema,RosterResponseSchema} from '@dota/contracts';
import {IdentityRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedProMaps} from '../../../tests/helpers/pro-maps.js';
import {catalogTeamId,catalogPlayerId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string;
const lineup=Array.from({length:5},(_,i)=>({playerId:String(BigInt(catalogPlayerId)+BigInt(i)),rolePos:i+1,isStandin:false}));
const route=`/api/v1/teams/${catalogTeamId}/roster-cohesion`;
beforeAll(async()=>{
  database=await testDatabase();await seedProMaps(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-roster',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-roster',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const post=(payload:unknown={lineup},url=route)=>app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
test('owner, same-origin and CSRF protect read-only POST; valid report is no-store and retrospective',async()=>{
  expect((await app.inject({method:'POST',url:route,payload:{lineup}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:route,headers:{cookie,origin:'http://localhost:5173'},payload:{lineup}})).statusCode).toBe(403);
  const response=await post();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const r=RosterReportSchema.parse(response.json());expect(r.actual.exactFive).toMatchObject({nRaw:2,wins:1,winRate:0.5});
  expect(r.actual.pairs.every(p=>p.nRaw===2)).toBe(true);expect(r.actual.players[0]?.selectedRoleMaps).toBe(2);
  expect(r.churn).toMatchObject({maps:2,uniqueFives:1,changedTransitions:0});expect(r.predictionEligibility).toBe('not_assessed');
});
test('new fifth player does not inherit old organization wins and expected comparison is explicit',async()=>{
  const selected=lineup.map((p,i)=>i===4?{...p,playerId:String(BigInt(catalogPlayerId)+5n),isStandin:true}:p);
  const r=RosterReportSchema.parse((await post({lineup:selected,expectedLineup:lineup})).json());
  expect(r.actual.exactFive).toMatchObject({nRaw:0,winRate:null});expect(r.expected?.exactFive.nRaw).toBe(2);
  expect(r.comparison).toMatchObject({retainedPlayers:4,retainedPairLinks:6,addedPairLinks:4});
  expect(r.actual.pairs.filter(p=>p.nRaw===2)).toHaveLength(6);expect(r.actual.pairs.filter(p=>p.nRaw===0)).toHaveLength(4);
});
test('cross-organization actual sides are found through source accounts with corrupted canonical projections ignored',async()=>{
  await sql`UPDATE matches SET radiant_team_id=9007199254740995 WHERE id=8001`.execute(database.db);
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=8001`.execute(database.db);
  const r=RosterReportSchema.parse((await post()).json());expect(r.actual.exactFive.nRaw).toBe(2);expect(r.actual.exactFiveOrganizationMaps).toBe(1);
  expect(r.actual.players[0]?.organizations.map(o=>o.organizationId).sort()).toEqual([catalogTeamId,'9007199254740995']);
});
test('SQL cutoff excludes future starts and unfinished outcomes at microsecond precision',async()=>{
  const r=RosterReportSchema.parse((await post({lineup,cutoffAt:'2024-01-02T12:00:00.000Z'})).json());expect(r.actual.exactFive.nRaw).toBe(1);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id)
    VALUES(8200,'2024-01-02T11:30:00.000001Z',1800,true,true,${catalogTeamId})`.execute(database.db);
  const edge=RosterReportSchema.parse((await post({lineup,cutoffAt:'2024-01-02T12:00:00.000Z'})).json());
  expect(edge.coverage.unfinished).toBe(1);expect(edge.provenance.some(p=>p.matchId==='8200')).toBe(false);
});
test('unverified slots have null history and no baseline comparison; verified newcomers have zero',async()=>{
  const partial=lineup.map((p,i)=>i===4?{...p,playerId:null}:p);
  const r=RosterReportSchema.parse((await post({lineup:partial})).json());expect(r.actual.exactFive.nRaw).toBeNull();expect(r.comparison).toBeNull();
  await sql`INSERT INTO players(id,nickname) VALUES(99001,'Synthetic unverified'),(99002,'Synthetic newcomer')`.execute(database.db);
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:'99002',externalAccountId:'9999',provider:'opendota',status:'verified',
    eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:newcomer',source:'synthetic'});
  for(const [id,n] of [['99001',null],['99002',0]] as const){const result=RosterReportSchema.parse((await post({lineup:lineup.map((p,i)=>i===4?{...p,playerId:id}:p)})).json());
    expect(result.actual.players[4]?.nRaw).toBe(n);expect(result.actual.exactFive.nRaw).toBe(n);}
});
test('malformed IDs, duplicates, invalid/future dates and unknown players return structured 400',async()=>{
  for(const body of [{lineup:lineup.map(()=>lineup[0])},{lineup:lineup.map(p=>({...p,playerId:'1e3'}))},{lineup,cutoffAt:'2999-01-01T00:00:00.000Z'},
    {lineup,fromAt:'2025-01-01T00:00:00.000Z',cutoffAt:'2024-01-01T00:00:00.000Z'},{lineup:lineup.map((p,i)=>i===4?{...p,playerId:'99999'}:p)}]){
    const r=await post(body);expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe('VALIDATION_ERROR');}
  expect((await post({lineup},'/api/v1/teams/99999/roster-cohesion')).statusCode).toBe(404);
});
test('conflicting account links never inherit the current cached canonical attribution',async()=>{
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:lineup[1]!.playerId,externalAccountId:'1000',provider:'opendota',status:'verified',
    eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:conflict',source:'synthetic'});
  const r=RosterReportSchema.parse((await post()).json());expect(r.actual.players[0]?.nRaw).toBeNull();expect(r.actual.exactFive.nRaw).toBeNull();
  expect(r.churn.uniqueFives).toBeNull();expect(r.coverage.incompleteSides).toBeGreaterThan(0);
});
test('large windows fail explicitly instead of returning truncated cohesion',async()=>{
  await sql`INSERT INTO matches(id,started_at,is_pro,radiant_win,duration_seconds,radiant_team_id)
    SELECT 100000+n,'2025-01-01'::timestamptz,true,true,1800,${catalogTeamId}::bigint FROM generate_series(1,5001) n`.execute(database.db);
  expect(RosterResponseSchema.parse((await post()).json())).toMatchObject({status:'unavailable',reason:'WINDOW_TOO_LARGE'});
});
