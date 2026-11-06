import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {RankedContextReportSchema} from '@dota/contracts';
import {RankedContextRepository,IdentityRepository,sql} from '@dota/db';
import {RankedContextClient} from '@dota/ingestion';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedProMaps} from '../../../tests/helpers/pro-maps.js';
import {catalogPlayerId} from '../../../tests/helpers/catalog.js';
import {seedRankedContext,rankedContextResponse} from '../../../tests/helpers/ranked-context.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
import {RankedPracticeService} from '../src/modules/catalog/ranked-practice.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,service:RankedPracticeService,seed:Awaited<ReturnType<typeof seedRankedContext>>,cookie:string,csrf:string,calls=0,
 mode:'normal'|'partial'='normal',failAt=0,delayMs=0,mutation:(()=>Promise<void>)|null=null;
const route='/api/v1/ranked-practice/context',token='synthetic-context-api-key',player=(offset:number)=>String(BigInt(catalogPlayerId)+BigInt(offset));
const fakeFetch:typeof fetch=async(_,init)=>{
 calls++;if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));if(mutation){const f=mutation;mutation=null;await f();}
 if(calls===failAt)return new Response('{}',{status:503,headers:{'Retry-After':'60'}});
 const body=JSON.parse(String(init?.body)),data=rankedContextResponse(body.query,seed.rows,String(body.variables.account));
 if(mode==='partial')for(const [key,value] of Object.entries(data)){const map=value as {id:number;players:{heroId:number}[]}|null;if(map?.id===990021)data[key]=null;if(map?.id===990020)map.players[0]!.heroId=2;}
 return new Response(JSON.stringify({data}));
};
beforeAll(async()=>{
 database=await testDatabase();await seedProMaps(database.db);seed=await seedRankedContext(database.db);const config=readConfig({DATABASE_URL:database.url,RANKED_PRACTICE_ENABLED:'true',STRATZ_API_TOKEN:token}),password=randomBytes(24).toString('base64url');
 await new AuthService(database.db).provision('synthetic-context-owner',password);service=new RankedPracticeService(database.db,config,fakeFetch);app=await buildApp(config,{db:database.db,logger:false,rankedPracticeFetch:fakeFetch});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-context-owner',password}}),cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const input=(refresh=false)=>({playerId:seed.playerId,parentObservationId:seed.parentId,refresh});
const post=(payload:unknown=input())=>app.inject({method:'POST',url:route,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
const read=(refresh=false)=>service.context.report(input(refresh));
const expire=()=>sql`UPDATE ranked_context_map_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
const receiptCount=async()=>(await sql`SELECT id FROM ranked_context_receipts`.execute(database.db)).rows.length;
const resetQuota=()=>sql`UPDATE role_profile_stratz_quota SET blocked_until='-infinity',next_request_at='-infinity'`.execute(database.db);
test('owner/CSRF and strict player/parent-only boundary reject before provider access',async()=>{
 expect((await app.inject({method:'POST',url:route,payload:input()})).statusCode).toBe(401);expect((await app.inject({method:'POST',url:route,headers:{cookie},payload:input()})).statusCode).toBe(403);
 for(const p of [{...input(),playerId:'999999'},{...input(),playerId:1000},{...input(),accountId:'1000'},{...input(),matchIds:['1']},{...input(),parentObservationId:'bad'}])expect((await post(p)).statusCode).toBe(400);expect(calls).toBe(0);
});
test('cache-only/unconfigured/disabled/wrong parent reads never create work or use HTTP',async()=>{
 const response=await post();expect(response.headers['cache-control']).toBe('no-store');expect(RankedContextReportSchema.parse(response.json())).toMatchObject({status:'not_loaded',selectedMaps:20,parentGames:21,matchedMaps:0});
 expect((await post({...input(true),parentObservationId:randomUUID()})).json()).toMatchObject({status:'unavailable',reason:'parent_changed',maps:[]});
 for(const env of [{RANKED_PRACTICE_ENABLED:'true'},{}]){
  const other=new RankedPracticeService(database.db,readConfig({DATABASE_URL:database.url,...env}),fakeFetch);expect(await other.context.report(input(true))).toMatchObject({status:'unavailable',maps:[]});
 }
 expect(calls).toBe(0);expect(await receiptCount()).toBe(0);expect((await sql`SELECT account_id FROM ranked_context_leases`.execute(database.db)).rows).toHaveLength(0);
});
test('explicit capture uses5 batches for latest20, freezes evidence and preserves base/pro denominators',async()=>{
 const before=(await sql<{hash:string}>`SELECT md5(payload::text) hash FROM ranked_practice_observations WHERE id=${seed.parentId}::uuid`.execute(database.db)).rows[0]!.hash;
 const response=await post(input(true));expect(response.statusCode).toBe(200);const report=RankedContextReportSchema.parse(response.json());expect(report).toMatchObject({status:'ready',parentGames:21,selectedMaps:20,matchedMaps:20});expect(report.maps[0]).toMatchObject({matchId:'990020',position:'POSITION_2',roleBasis:'estimated',gameVersionCode:'190',stale:false});
 expect(report.maps.some(m=>m.matchId==='990000')).toBe(false);expect(calls).toBe(5);expect(await receiptCount()).toBe(5);expect((await sql`SELECT match_id FROM ranked_context_map_cache`.execute(database.db)).rows).toHaveLength(20);
 expect((await sql<{hash:string}>`SELECT md5(payload::text) hash FROM ranked_practice_observations WHERE id=${seed.parentId}::uuid`.execute(database.db)).rows[0]!.hash).toBe(before);expect((await sql`SELECT id FROM matches WHERE id>=990000`.execute(database.db)).rows).toHaveLength(0);
},30000);
test('cache replay and repeated refresh use zero new HTTP; raw context evidence is immutable',async()=>{
 for(const refresh of [false,true])expect((await post(input(refresh))).json()).toMatchObject({status:'ready',matchedMaps:20});expect(calls).toBe(5);expect(await receiptCount()).toBe(5);
 await expect(sql`UPDATE ranked_context_receipts SET account_id=1001`.execute(database.db)).rejects.toThrow('ranked_practice_immutable');await expect(sql`DELETE FROM ranked_context_receipts`.execute(database.db)).rejects.toThrow('ranked_practice_immutable');
});
test('a refreshed parent reuses matching per-map cache and loads only the one newly selected ID',async()=>{
 const oldParent=seed.parentId,before=calls;seed=await seedRankedContext(database.db,{extra:1,nowSeconds:seed.rows[0]!.start_time+86400});
 const report=await read(true);expect(report).toMatchObject({status:'ready',selectedMaps:20,matchedMaps:20,parentGames:22});expect(calls).toBe(before+1);expect(report.maps.filter(m=>m.sourceParentObservationId===oldParent)).toHaveLength(19);
 expect(await service.context.report({...input(true),parentObservationId:oldParent})).toMatchObject({status:'unavailable',reason:'parent_changed',maps:[]});expect(calls).toBe(before+1);
},30000);
test('partial/null and conflicting hero are retained as evidence and cannot apply metadata',async()=>{
 await expire();mode='partial';const report=await read(true);mode='normal';expect(report).toMatchObject({status:'partial',matchedMaps:18,selectedMaps:20});
 expect(report.maps.find(m=>m.matchId==='990021')).toMatchObject({status:'unavailable',position:null,gameVersionCode:null,reason:'source_map_unavailable'});expect(report.maps.find(m=>m.matchId==='990020')).toMatchObject({status:'conflict',position:null,gameVersionCode:null,reason:'hero_mismatch'});
 expect(report.maps.every(m=>m.sourceReceiptId!==null)).toBe(true);
},30000);
test('failed second batch preserves first and stale evidence, honors cooldown without retry',async()=>{
 await expire();const before=calls,count=await receiptCount();failAt=calls+2;const report=await read(true);failAt=0;
 expect(calls).toBe(before+2);expect(await receiptCount()).toBe(count+1);expect(report).toMatchObject({status:'partial',reason:'source_http_error',matchedMaps:20});expect(report.retryAt).not.toBeNull();expect(report.maps.filter(m=>m.stale)).toHaveLength(16);
 await read(true);expect(calls).toBe(before+2);
},30000);
test('stale lease cannot publish/clear a successor; hashes and selected-parent membership are mandatory',async()=>{
 const repo=new RankedContextRepository(database.db),other=await seedRankedContext(database.db,{playerId:player(1),accountId:'1001'}),row=other.rows.at(-1)!;
 const result=await new RankedContextClient({beforeRequest:async()=>{},observe:async()=>{}},token,async()=>new Response(JSON.stringify({data:rankedContextResponse(`m0:match(id:${row.match_id})`,other.rows,'1001')}))).lookup('1001',[String(row.match_id)]);
 const old=await repo.claim('1001');await sql`UPDATE ranked_context_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=1001`.execute(database.db);const fresh=await repo.claim('1001');expect(fresh).not.toBeNull();expect(fresh).not.toBe(old);
 const e=result.receipt.entries[0]!,foreign={...result.receipt,entries:[{...e,matchId:'1',map:e.map?{...e.map,matchId:'1'}:null}]};await expect(repo.publish(other.playerId,other.parentId,'1001',fresh!,foreign,result.rawBody)).rejects.toThrow('ranked_context_membership_invalid');
 await expect(repo.publish(other.playerId,other.parentId,'1001',fresh!,result.receipt,'tampered')).rejects.toThrow('invalid_context_receipt');expect(await repo.publish(other.playerId,other.parentId,'1001',old!,result.receipt,result.rawBody)).toBe(false);await repo.fail('1001',old!,'source_http_error');expect(await repo.publish(other.playerId,other.parentId,'1001',fresh!,result.receipt,result.rawBody)).toBe(true);await repo.finish('1001',fresh!);
});
test('retry after cooldown recovers only16 outstanding maps and reuses the4 successful rows',async()=>{
 await resetQuota();await sql`UPDATE ranked_context_leases SET retry_at=clock_timestamp()-interval '1 second' WHERE account_id=1000`.execute(database.db);
 const before=calls,report=await read(true);expect(calls).toBe(before+4);expect(report).toMatchObject({status:'ready',matchedMaps:20,selectedMaps:20});
},30000);
test('concurrent manual requests share one lease and consume one five-request capture',async()=>{
 await resetQuota();seed=await seedRankedContext(database.db,{playerId:player(2),accountId:'1002'});const before=calls;delayMs=40;
 const responses=await Promise.all([read(true),read(true)]);delayMs=0;expect(calls).toBe(before+5);expect(responses.some(r=>r.status==='ready')).toBe(true);expect(responses.some(r=>r.reason==='refresh_in_progress')).toBe(true);
},30000);
test('parent changed during network cannot publish or apply old-scope context',async()=>{
 seed=await seedRankedContext(database.db,{playerId:player(3),accountId:'1003'});const requested=input(true),before=calls;
 mutation=async()=>{seed=await seedRankedContext(database.db,{playerId:player(3),accountId:'1003',extra:1,nowSeconds:seed.rows[0]!.start_time+86400});};
 expect(await service.context.report(requested)).toMatchObject({status:'unavailable',reason:'parent_changed',maps:[]});expect(calls).toBe(before+1);expect((await sql`SELECT id FROM ranked_context_receipts WHERE account_id=1003`.execute(database.db)).rows).toHaveLength(0);
},30000);
test('identity changed during network prevents context publication under an obsolete mapping',async()=>{
 seed=await seedRankedContext(database.db,{playerId:player(4),accountId:'1004'});mutation=async()=>{
  const p=(await sql<{id:string}>`INSERT INTO players(nickname) VALUES('Synthetic context identity conflict') RETURNING id::text`.execute(database.db)).rows[0]!;
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:p.id,externalAccountId:'1004',provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),evidenceRef:'synthetic:context-conflict',source:'synthetic'});
 };
 const report=await read(true);expect(report.status).toBe('unavailable');expect(report.reason).toMatch(/^identity_/);expect(report.maps).toEqual([]);expect((await sql`SELECT id FROM ranked_context_receipts WHERE account_id=1004`.execute(database.db)).rows).toHaveLength(0);
},30000);
test('cached facts are rechecked against corrected parent core fields on every read',async()=>{
 await resetQuota();seed=await seedRankedContext(database.db,{playerId:player(5),accountId:'1005'});await read(true);const before=calls;
 await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES(2,'synthetic_context_hero','Synthetic context hero')`.execute(database.db);
 seed=await seedRankedContext(database.db,{playerId:player(5),accountId:'1005',heroId:2,nowSeconds:seed.rows[0]!.start_time+86400});const report=await read();expect(calls).toBe(before);expect(report).toMatchObject({status:'partial',matchedMaps:0,selectedMaps:20});expect(report.maps.every(m=>m.status==='conflict'&&m.reason==='hero_mismatch'&&m.position===null&&m.gameVersionCode===null)).toBe(true);
},30000);
