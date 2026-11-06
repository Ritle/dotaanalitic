import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {RankedPracticeReportSchema} from '@dota/contracts';
import {sql,RankedPracticeRepository} from '@dota/db';
import {RankedPracticeClient} from '@dota/ingestion';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedProMaps} from '../../../tests/helpers/pro-maps.js';
import {catalogPlayerId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
import {RankedPracticeService} from '../src/modules/catalog/ranked-practice.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,calls=0,heroId=1,mode:'empty'|'error'|'map'='empty';
const input={playerId:catalogPlayerId,provider:'opendota'},route='/api/v1/ranked-practice';
beforeAll(async()=>{
 database=await testDatabase();await seedProMaps(database.db);const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-ranked-owner',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,RANKED_PRACTICE_ENABLED:'true'}),{db:database.db,logger:false,rankedPracticeFetch:async()=>{calls++;
  if(mode==='error')return new Response('{}',{status:503,headers:{'Retry-After':'60'}});
  return new Response(JSON.stringify(mode==='empty'?[]:[{match_id:999999,hero_id:heroId,start_time:Math.floor(Date.now()/1000)-7200,duration:1800,player_slot:128,radiant_win:false,lobby_type:7,game_mode:22}]));}});
 const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-ranked-owner',password}});
 const cookies=r.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=r.json().csrfToken;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(payload:unknown=input)=>app.inject({method:'POST',url:route,headers:headers(),payload});

test('auth, CSRF, local player and exact request boundary reject before upstream access',async()=>{
 expect((await app.inject({method:'POST',url:route,payload:input})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:route,headers:{cookie},payload:input})).statusCode).toBe(403);
 for(const payload of [{...input,playerId:'999999999'},{...input,playerId:1000},{...input,accountId:'1000'},{...input,cutoffAt:'2023-01-01T00:00:00.000Z'}])expect((await post(payload)).statusCode).toBe(400);
 expect(calls).toBe(0);
});
test('cache-only read is not_loaded, unconfigured STRATZ stays unavailable with no HTTP',async()=>{
 const r=await post();expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
 expect(RankedPracticeReportSchema.parse(r.json())).toMatchObject({accountId:'1000',status:'not_loaded',statisticsEnabled:false,observation:null});
 expect((await post({...input,provider:'stratz',refresh:true})).json()).toMatchObject({status:'unavailable',reason:'not_configured'});expect(calls).toBe(0);
});
test('empty response persists immutable raw evidence and repeated explicit refresh uses negative cache',async()=>{
 for(let i=0;i<2;i++){
  const r=await post({...input,refresh:true});expect(r.statusCode).toBe(200);
  expect(RankedPracticeReportSchema.parse(r.json())).toMatchObject({status:'empty',stale:false,statisticsEnabled:true,heroSummary:{games:0,wins:0,winRate:null,lastPlayedAt:null,heroes:[]},observation:{knownAt:null,maps:[],coverage:{receivedRows:0,historyCompleteness:'unknown'}}});
 }
 expect(calls).toBe(1);expect((await sql`SELECT id FROM ranked_practice_observations`.execute(database.db)).rows).toHaveLength(1);
 const raw=(await sql<{raw_bodies:unknown}>`SELECT raw_bodies FROM ranked_practice_observations`.execute(database.db)).rows[0]!;expect(raw.raw_bodies).toEqual(['[]']);
 await expect(sql`UPDATE ranked_practice_observations SET account_id=1001`.execute(database.db)).rejects.toThrow('ranked_practice_immutable');
 await expect(sql`DELETE FROM ranked_practice_observations`.execute(database.db)).rejects.toThrow('ranked_practice_immutable');
});
test('expired cache remains visible, concurrent explicit refresh has a single source claim and appends evidence',async()=>{
 await sql`UPDATE ranked_practice_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const stale=(await post()).json();expect(stale).toMatchObject({status:'partial',stale:true});expect(calls).toBe(1);
 mode='map';const results=await Promise.all([post({...input,refresh:true}),post({...input,refresh:true})]);expect(results.every(r=>r.statusCode===200)).toBe(true);expect(calls).toBe(2);
 const r=RankedPracticeReportSchema.parse((await post()).json());expect(r).toMatchObject({status:'ready',stale:false,statisticsEnabled:true,heroSummary:{observationId:r.observationId,games:1,wins:1,winRate:1,heroes:[{heroId:'1',heroName:'Synthetic Hero',games:1,wins:1,winRate:1}]}});expect(r.observation!.maps).toHaveLength(1);
 expect((await sql`SELECT id FROM ranked_practice_observations`.execute(database.db)).rows).toHaveLength(2);
 expect((await sql`SELECT id FROM matches WHERE id=999999`.execute(database.db)).rows).toHaveLength(0);
},30000);
test('source hero missing from local catalogue is explicitly excluded and is not usable history',async()=>{
 heroId=999999;const playerId=String(BigInt(catalogPlayerId)+2n),r=RankedPracticeReportSchema.parse((await post({...input,playerId,refresh:true})).json());heroId=1;
 expect(r.status).toBe('partial');expect(r.observation!.maps).toEqual([]);expect(r.observation!.coverage.excluded).toEqual({unknown_hero:1});
},30000);
test('source failure preserves previous observation, records cooldown and prevents repeat HTTP',async()=>{
 await sql`UPDATE ranked_practice_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);mode='error';
 const before=calls,r=RankedPracticeReportSchema.parse((await post({...input,refresh:true})).json());expect(calls).toBe(before+1);
 expect(r).toMatchObject({status:'partial',stale:true,reason:'cooldown'});expect(r.retryAt).not.toBeNull();expect(r.observation!.maps).toHaveLength(1);
 await post({...input,refresh:true});expect(calls).toBe(before+1);expect((await sql`SELECT id FROM ranked_practice_observations`.execute(database.db)).rows).toHaveLength(3);
});
test('unknown identity never starts retrieval',async()=>{
 await sql`INSERT INTO players(nickname) VALUES('Synthetic unknown ranked identity')`.execute(database.db);
 const player=(await sql<{id:string}>`SELECT id::text FROM players WHERE nickname='Synthetic unknown ranked identity'`.execute(database.db)).rows[0]!,before=calls;
 expect((await post({...input,playerId:player.id,refresh:true})).json()).toMatchObject({status:'unavailable',reason:'identity_unknown',accountId:null});expect(calls).toBe(before);
});
test('expired lease cannot publish or clear a newer claim, raw hashes must match immutable evidence',async()=>{
 const repo=new RankedPracticeRepository(database.db),playerId=String(BigInt(catalogPlayerId)+1n),accountId='1001';
 const result=await new RankedPracticeClient('opendota',{beforeRequest:async()=>{},observe:async()=>{}},{},async()=>new Response('[]')).read(accountId);
 const old=await repo.claim('opendota',accountId);expect(old).not.toBeNull();
 await sql`UPDATE ranked_practice_cache SET lease_until=clock_timestamp()-interval '1 second' WHERE source_key='opendota:1001'`.execute(database.db);
 const fresh=await repo.claim('opendota',accountId);expect(fresh).not.toBeNull();expect(fresh).not.toBe(old);
 await expect(repo.publish(playerId,'opendota',accountId,fresh!,result.observation,['tampered'])).rejects.toThrow('invalid_ranked_observation');
 expect(await repo.publish(playerId,'opendota',accountId,old!,result.observation,result.rawBodies)).toBe(false);
 await repo.fail('opendota',accountId,old!,'source_http_error');
 expect(await repo.publish(playerId,'opendota',accountId,fresh!,result.observation,result.rawBodies)).toBe(true);
 const saved=await repo.read('opendota',accountId);expect(saved.fresh).toBe(true);expect(saved.identityRevision).toMatch(/^\d+$/);
});
test('feature defaults off and cannot refresh even with a valid verified account',async()=>{
 let requested=0;const service=new RankedPracticeService(database.db,readConfig({DATABASE_URL:database.url}),async()=>{requested++;return new Response('[]');});
 expect(await service.report({...input,provider:'opendota',refresh:true})).toMatchObject({status:'unavailable',reason:'disabled',observation:null});expect(requested).toBe(0);
});
test('publication rechecks canonical identity and cannot save another player under a leased account',async()=>{
 const repo=new RankedPracticeRepository(database.db),observation=(await repo.read('opendota','1001')).observation!;
 await sql`UPDATE ranked_practice_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE source_key='opendota:1001'`.execute(database.db);
 const lease=await repo.claim('opendota','1001');expect(lease).not.toBeNull();
 const before=(await sql`SELECT id FROM ranked_practice_observations`.execute(database.db)).rows.length;
 await expect(repo.publish(catalogPlayerId,'opendota','1001',lease!,observation,['[]'])).rejects.toThrow('ranked_identity_changed');
 expect((await sql`SELECT id FROM ranked_practice_observations`.execute(database.db)).rows).toHaveLength(before);
 await repo.fail('opendota','1001',lease!,'identity_changed');
});
test('legacy v1 cache stays readable but stale and can refresh before TTL without rewriting old evidence',async()=>{
 const repo=new RankedPracticeRepository(database.db),playerId=String(BigInt(catalogPlayerId)+3n),accountId='1003';
 const current=await new RankedPracticeClient('opendota',{beforeRequest:async()=>{},observe:async()=>{}},{},async()=>new Response('[]')).read(accountId);
 const legacy={...current.observation,adapterVersion:'ranked-practice-reader-v1'},legacyId=randomUUID();
 await sql`INSERT INTO ranked_practice_observations(id,player_id,account_id,provider,identity_revision,fetched_at,payload,raw_bodies)
  VALUES(${legacyId}::uuid,${playerId}::bigint,${accountId}::bigint,'opendota',1,${legacy.fetchedAt}::timestamptz,${JSON.stringify(legacy)}::jsonb,${JSON.stringify(current.rawBodies)}::jsonb)`.execute(database.db);
 await sql`INSERT INTO ranked_practice_cache(source_key,observation_id,expires_at) VALUES('opendota:1003',${legacyId}::uuid,clock_timestamp()+interval '1 hour')`.execute(database.db);
 const old=await repo.read('opendota',accountId);expect(old.observation?.adapterVersion).toBe('ranked-practice-reader-v1');expect(old.fresh).toBe(false);
 expect((await post({...input,playerId})).json()).toMatchObject({statisticsEnabled:false,heroSummary:null});
 const lease=await repo.claim('opendota',accountId);expect(lease).not.toBeNull();
 await expect(repo.publish(playerId,'opendota',accountId,lease!,legacy,current.rawBodies)).rejects.toThrow('invalid_ranked_observation');
 expect(await repo.publish(playerId,'opendota',accountId,lease!,current.observation,current.rawBodies)).toBe(true);
 expect((await repo.read('opendota',accountId)).fresh).toBe(true);
 expect((await post({...input,playerId})).json()).toMatchObject({statisticsEnabled:true,heroSummary:{games:0,winRate:null}});
 expect((await sql<{payload:{adapterVersion:string}}>`SELECT payload FROM ranked_practice_observations WHERE id=${legacyId}::uuid`.execute(database.db)).rows[0]!.payload.adapterVersion).toBe('ranked-practice-reader-v1');
});
test('STRATZ is a coverage reader until nonempty ranked fields are empirically validated',async()=>{
 let upstream=0;const service=new RankedPracticeService(database.db,readConfig({DATABASE_URL:database.url,RANKED_PRACTICE_ENABLED:'true',STRATZ_API_TOKEN:'synthetic-ranked-key'}),async()=>{upstream++;return new Response(JSON.stringify({data:{player:{steamAccountId:1000,matches:[]}}}));});
 const result=await service.report({...input,provider:'stratz',refresh:true});expect(upstream).toBe(1);expect(result).toMatchObject({status:'empty',statisticsEnabled:false,heroSummary:null});
});
