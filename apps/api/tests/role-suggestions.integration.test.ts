import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {RoleSuggestionReportSchema} from '@dota/contracts';
import {sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedProMaps} from '../../../tests/helpers/pro-maps.js';
import {catalogPlayerId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string;
const playerIds=Array.from({length:5},(_,i)=>String(BigInt(catalogPlayerId)+BigInt(i)));
const body={playerIds,cutoffAt:'2024-01-03T00:00:00.000Z'};
const url='/api/v1/lineup-role-suggestions';
beforeAll(async()=>{
  database=await testDatabase();await seedProMaps(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-roles',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-roles',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(payload:unknown=body)=>app.inject({method:'POST',url,headers:headers(),payload});
test('owner/CSRF protect suggestions; current reconstruction is explicit and IDs remain bigint-safe',async()=>{
  expect((await app.inject({method:'POST',url,payload:body})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie},payload:body})).statusCode).toBe(403);
  const r=await post();expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
  const report=RoleSuggestionReportSchema.parse(r.json());expect(report.players.map(p=>p.suggestedRole)).toEqual([1,2,3,4,5]);
  expect(report.players[0]).toMatchObject({playerId:catalogPlayerId,nRaw:2,nUsed:2,basis:'confirmed_history'});
  expect(report.warnings).toContain('CURRENT_RECONSTRUCTION_NOT_HISTORICAL_AVAILABILITY');
});
test('malformed/duplicate/unknown/too many players and future cutoff return structured 400',async()=>{
  for(const payload of [{playerIds:['1e3']},{playerIds:[playerIds[0],playerIds[0]]},{playerIds:['99999']},
    {playerIds:[]},{playerIds:[...playerIds,'99999']},{...body,cutoffAt:'2999-01-01T00:00:00.000Z'}]){
    const r=await post(payload);expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe('VALIDATION_ERROR');
  }
});
test('no eligible pro history yields null; source facts are not rewritten',async()=>{
  const before=(await sql`SELECT count(*)::text n FROM match_field_observations`.execute(database.db)).rows;
  const report=RoleSuggestionReportSchema.parse((await post({...body,cutoffAt:'2023-01-01T00:00:00.000Z'})).json());
  expect(report.status).toBe('unavailable');expect(report.players.every(p=>p.suggestedRole===null&&p.nRaw===0)).toBe(true);
  expect((await sql`SELECT count(*)::text n FROM match_field_observations`.execute(database.db)).rows).toEqual(before);
});
test('accepted lane/GPM payload is bound to map and account; receipt replay is one vote, conflicts abstain',async()=>{
  const startedAt='2026-11-01T00:00:00.000Z',matchId='8100';
  await sql`INSERT INTO matches(id,started_at,is_pro,ingest_state,duration_seconds,radiant_win) VALUES(${matchId},${startedAt},true,'accepted',1800,true)`.execute(database.db);
  const players=Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,account_id:1000+i,lane_role:[1,2,3,3,1][i%5],gold_per_min:[600,650,500,300,250][i%5]}));
  for(const p of players)await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id,gpm)
    VALUES(${matchId},${p.player_slot},${p.player_slot<128?'radiant':'dire'},1,${p.account_id},${p.gold_per_min})`.execute(database.db);
  const payload={match_id:Number(matchId),start_time:Date.parse(startedAt)/1000,duration:1800,radiant_win:true,players};
  const insert=async(source:unknown,digest:string)=>sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,canonical_match_id,adapter_version,
    normalizer_version,context_sha256,payload_sha256,fetched_at,source_payload,status,reasons)
    VALUES('opendota',${matchId},${matchId},'synthetic','synthetic',${digest.repeat(64)},${digest.repeat(64)},'2026-11-02',${JSON.stringify(source)}::jsonb,'accepted','[]')`.execute(database.db);
  await insert(payload,'a');await insert(payload,'b');
  const request={playerIds,cutoffAt:'2026-11-03T00:00:00.000Z'};
  const report=RoleSuggestionReportSchema.parse((await post(request)).json());
  expect(report.players.map(p=>p.suggestedRole)).toEqual([1,2,3,4,5]);expect(report.players[0]).toMatchObject({nRaw:1,nUsed:1,basis:'lane_gpm_estimate'});
  expect(report.players[0]!.evidence[0]!.proofIds).toHaveLength(2);
  // A syntactically valid but contradictory accepted source is not resolved by fetch recency.
  await insert({...payload,players:players.map((p,i)=>i===0?{...p,lane_role:3}:p)},'c');
  expect(RoleSuggestionReportSchema.parse((await post(request)).json()).players.every(p=>p.suggestedRole===null)).toBe(true);
});
