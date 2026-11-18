import {beforeAll,afterAll,test,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedDraft,draftInput} from '../../../tests/helpers/draft.js';
import {ScenarioRepository,sql,registrySha} from '@dota/db';
import {OpenDotaClient,IngestionService} from '@dota/ingestion';
import {AuthService} from '../src/modules/auth/service.js';
import {DraftCaptureRepository} from '../src/modules/scenarios/draft-capture-repository.js';
import {DraftNativeRepository} from '../src/modules/scenarios/draft-native-repository.js';
import {verifyNativeDraft} from '../src/modules/scenarios/draft-native-verify.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,owner:string,cookie:string,csrf:string;
const matchId='9007199254742990';
beforeAll(async()=>{
  database=await testDatabase();await seedDraft(database.db);const q=draftInput();
  await sql`UPDATE teams SET opendota_team_id=CASE WHEN id=${q.teamAId}::bigint THEN 111 ELSE 222 END WHERE id IN (${q.teamAId}::bigint,${q.teamBId}::bigint)`.execute(database.db);
  await sql`UPDATE leagues SET opendota_league_id=1 WHERE id=1`.execute(database.db);
  const payload={match_id:matchId,start_time:Math.floor(Date.now()/1000)-600,duration:60,radiant_win:true,radiant_team_id:111,dire_team_id:222,leagueid:1,
    players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,account_id:1000+i}))};
  const client=new OpenDotaClient({},{fetch:async url=>new Response(JSON.stringify(url.pathname==='/api/heroes'?
    Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
    url.pathname==='/api/leagues'?[{leagueid:1,name:'Synthetic event',tier:'professional'}]:payload))});
  await new IngestionService(database.db,client).ingest(matchId);
  const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-native',password)).id;
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-native',password}});
  const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},60000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
async function setup(){const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1})));
  const scenario=await new ScenarioRepository(database.db).save(owner,q),capture=await new DraftCaptureRepository(database.db).create(owner,scenario.id,{expectedRevision:1});
  return {scenario,capture,url:`/api/v1/scenarios/${scenario.id}/draft-captures/1/native-binding`};}
const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
test('private owner-only API, CSRF, strict payload and cross-owner isolation',async()=>{
  const s=await setup();expect((await app.inject({method:'GET',url:s.url})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:s.url,headers:{cookie,origin:'http://localhost:5173'},payload:{requestId:randomUUID(),matchId}})).statusCode).toBe(403);
  expect((await post(s.url,{requestId:randomUUID(),matchId,primaryEligible:true})).statusCode).toBe(400);
  expect((await app.inject({method:'GET',url:s.url,headers:{cookie}})).json()).toEqual({binding:null,latestAttempt:null});
  await expect(new DraftNativeRepository(database.db).create(randomUUID(),s.scenario.id,1,{requestId:randomUUID(),matchId})).rejects.toMatchObject({code:'NOT_FOUND'});
  await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
  try{expect((await post(s.url,{requestId:randomUUID(),matchId})).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url:s.url,headers:{cookie}})).statusCode).toBe(403);
  }finally{await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);}
});
test('binds verified native map without ordinal, replays frozen evidence and leaves capture/predictions unchanged',async()=>{
  const s=await setup(),request={requestId:randomUUID(),matchId},r=await post(s.url,request);
  expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
  expect(r.json().result).toMatchObject({status:'verified',matchId,teamASide:'radiant',temporalStatus:'not_before_provider_start',mapOrdinalVerified:false,primaryEligible:false});
  const row=(await sql<{evidence_text:string;evidence_sha256:string}>`SELECT evidence_text,evidence_sha256 FROM owner_draft_native_bindings WHERE id=${request.requestId}::uuid`.execute(database.db)).rows[0]!;
  const e=JSON.parse(row.evidence_text);expect(registrySha(row.evidence_text)).toBe(row.evidence_sha256);
  expect(verifyNativeDraft({capture:s.capture,candidate:e.candidate,matchId,inspectedAt:e.result.inspectedAt})).toEqual(e.result);
  expect(await new DraftCaptureRepository(database.db).get(owner,s.scenario.id,1)).toEqual(s.capture);
  expect((await app.inject({method:'GET',url:s.url,headers:{cookie}})).json().binding).toEqual(r.json());
  expect((await sql`SELECT id FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('concurrent retries persist one binding; different known target conflicts and old revision remains readable',async()=>{
  const s=await setup(),request={requestId:randomUUID(),matchId},rs=await Promise.all([post(s.url,request),post(s.url,request)]);
  expect(rs.map(r=>r.statusCode)).toEqual([200,200]);expect(rs[0]!.json()).toEqual(rs[1]!.json());
  expect((await post(s.url,{requestId:randomUUID(),matchId})).json()).toEqual(rs[0]!.json());
  expect((await post(s.url,{requestId:randomUUID(),matchId:'123'})).statusCode).toBe(409);
  await new ScenarioRepository(database.db).save(owner,s.scenario.input,{id:s.scenario.id,expectedRevision:1});
  expect((await post(s.url,request)).json()).toEqual(rs[0]!.json());
});
test('unavailable attempts append and can be followed by a valid ID; request ID cannot change target',async()=>{
  const s=await setup(),request={requestId:randomUUID(),matchId:'123'},r=await post(s.url,request);
  expect(r.json().result).toMatchObject({status:'unavailable',reasons:['LOCAL_MAP_MISSING']});
  expect((await post(s.url,request)).json()).toEqual(r.json());
  expect((await post(s.url,{...request,matchId})).statusCode).toBe(409);
  const good=await post(s.url,{requestId:randomUUID(),matchId});expect(good.json().result.status).toBe('verified');
  expect((await sql`SELECT id FROM owner_draft_native_bindings WHERE capture_id=${s.capture.id}::uuid`.execute(database.db)).rows).toHaveLength(2);
});
test('DB enforces immutability, checksum and false model eligibility',async()=>{
  const s=await setup(),r=(await post(s.url,{requestId:randomUUID(),matchId})).json();
  await expect(sql`UPDATE owner_draft_native_bindings SET status='unavailable' WHERE id=${r.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`DELETE FROM owner_draft_native_bindings WHERE id=${r.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  const row=(await sql<{evidence_text:string}>`SELECT evidence_text FROM owner_draft_native_bindings WHERE id=${r.id}::uuid`.execute(database.db)).rows[0]!;
  const e=JSON.parse(row.evidence_text);e.result.primaryEligible=true;const text=JSON.stringify(e);
  await expect(sql`INSERT INTO owner_draft_native_bindings(id,owner_user_id,capture_id,requested_match_id,status,evidence_text,evidence_sha256,inspected_at)
    VALUES(${randomUUID()}::uuid,${owner}::uuid,${s.capture.id}::uuid,${matchId}::bigint,'verified',${text},${registrySha(text)},clock_timestamp())`.execute(database.db)).rejects.toThrow('draft_native_binding_invalid');
});
