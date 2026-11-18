import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {sql,IdentityRepository,PlayerHistoryRepository} from '@dota/db';
import {createPlayerHistoryQueue,enqueuePlayerHistory,PLAYER_HISTORY_QUEUE} from '@dota/ingestion';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {syntheticPlayerHistory} from '../../../tests/helpers/player-history.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
import {ComparisonHistoryResponseSchema} from '../src/modules/history/comparison-history-contract.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:Awaited<ReturnType<typeof buildApp>>,boss:Awaited<ReturnType<typeof createPlayerHistoryQueue>>,cookie:string,csrf:string,owner:string;
const a=['1','2','3','4','5'],b=['6','7','8','9','10'],other=['11','12','13','14','15'],path='/api/v1/players/comparison-history',calls:string[]=[];
let release:()=>void=()=>undefined,gate=new Promise<void>(r=>release=r),fail=false,old:string,runId:string;
const request=(method:'GET'|'POST',input:Record<string,unknown>={lineupA:a,lineupB:b})=>app.inject({method,url:path+(method==='GET'?'?'+new URLSearchParams(Object.entries(input).map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)])):''),headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},...(method==='POST'?{payload:input}:{})});
beforeAll(async()=>{
 database=await testDatabase();const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-auto-history',password)).id;
 for(let i=1;i<=10;i++)await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES(${i},${'synthetic_'+i},${'Synthetic '+i})`.execute(database.db);
 for(let i=1;i<=15;i++){
  await sql`INSERT INTO players(id,nickname) VALUES(${i},${'Synthetic '+i})`.execute(database.db);
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:String(i),externalAccountId:String(1000+i),provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),evidenceRef:'synthetic:auto-history-'+i,source:'synthetic'});
 }
 app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false,playerHistoryProvider:()=>{
  const fixture=syntheticPlayerHistory({gate,onCall:name=>calls.push(name)});
  return fail?{...fixture,discover:async()=>{calls.push('synthetic-failure');throw Error('synthetic source unavailable');}}:fixture;
 }});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-auto-history',password}}),cookies=login.headers['set-cookie'];
 cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;boss=await createPlayerHistoryQueue(database.url);
},30000);
afterAll(async()=>{release();await app?.close();await boss?.stop({graceful:true,timeout:10000});await database?.close();},30000);
it('requires authentication, owner and CSRF; validates disjoint identities and leaves historical comparisons offline',async()=>{
 expect((await app.inject(path+'?lineupA=1,2,3,4,5&lineupB=6,7,8,9,10')).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:path,headers:{cookie,origin:'http://localhost:5173'},payload:{lineupA:a,lineupB:b}})).statusCode).toBe(403);
 expect((await request('POST',{lineupA:a,lineupB:a})).statusCode).toBe(400);
 expect((await request('POST',{lineupA:a,lineupB:b,cutoffAt:'2099-01-01T00:00:00.000Z'})).statusCode).toBe(400);
 const historical=await request('POST',{lineupA:a,lineupB:b,cutoffAt:'2023-01-01T00:00:00.000Z'});expect(historical.statusCode,historical.body).toBe(200);expect(historical.json().groups.map((g:{state:string})=>g.state)).toEqual(['historical','historical']);
 expect((await request('GET')).json().groups.every((g:{history:{run:unknown}})=>g.history.run===null)).toBe(true);
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
 expect((await request('POST')).statusCode).toBe(403);expect((await request('GET')).statusCode).toBe(200);
 await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);
 expect(calls).toHaveLength(0);expect((await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows).toHaveLength(0);
});
it('uses global completed positive-pro coverage and excludes pubs, unknown pro, unfinished and future maps',async()=>{
 for(let i=0;i<9;i++){
  const pro=i===5?false:i===6?null:true,duration=i===7?null:1000,offset=i===8?'1 day':'-2 days';
  await sql`INSERT INTO matches(id,is_pro,ingest_state,started_at,duration_seconds,radiant_win) VALUES(${91000+i},${pro},'partial',clock_timestamp()+${offset}::interval,${duration},true)`.execute(database.db);
  for(let j=0;j<5;j++)await sql`INSERT INTO match_players(match_id,player_slot,side,player_id,source_account_id,hero_id) VALUES(${91000+i},${j},'radiant',${a[j]},${1001+j},${j+1})`.execute(database.db);
 }
 const response=await request('GET'),data=ComparisonHistoryResponseSchema.parse(response.json());
 expect(data.groups[0]).toMatchObject({state:'covered',coverage:a.map(playerId=>({playerId,nRaw:5})),history:{run:null}});
 expect(data.groups[1]).toMatchObject({state:'unavailable',coverage:[...b].sort().map(playerId=>({playerId,nRaw:0}))});
 expect(calls).toHaveLength(0);
});
it('reuses concurrent selected work with other options, processes only selected jobs, and imports idempotently',async()=>{
 const repo=new PlayerHistoryRepository(database.db);old=await enqueuePlayerHistory(boss,database.db,owner,(await repo.bindings(other))!,{windowDays:365,maxMaps:25});
 runId=await enqueuePlayerHistory(boss,database.db,owner,(await repo.bindings(b))!,{windowDays:730,maxMaps:10});
 const responses=await Promise.all([request('POST'),request('POST',{lineupA:[...a].reverse(),lineupB:[...b].reverse()})]);
 for(const response of responses){expect(response.statusCode,response.body).toBe(200);const data=ComparisonHistoryResponseSchema.parse(response.json());expect(data.groups[0].state).toBe('covered');expect(data.groups[1].history).toMatchObject({run:{id:runId},options:{windowDays:730,maxMaps:10}});}
 expect((await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows).toHaveLength(2);
 for(let i=0;i<60&&!calls.length;i++)await new Promise(r=>setTimeout(r,100));expect(calls).toEqual(['discover']);
 const queued=await boss.getJobById(PLAYER_HISTORY_QUEUE,old);expect(queued).toMatchObject({state:'created',priority:0});
 release();let data;for(let i=0;i<100;i++){data=ComparisonHistoryResponseSchema.parse((await request('GET')).json());if(data.groups[1].history?.run?.finishedAt)break;await new Promise(r=>setTimeout(r,100));}
 expect(data?.groups[1].history?.run).toMatchObject({status:'completed',report:{accepted:2}});
 expect((await repo.get(old))?.status).toBe('queued');expect((await sql`SELECT id FROM matches WHERE id>=99000000`.execute(database.db)).rows).toHaveLength(2);
 const before=calls.length;for(let i=0;i<2;i++)expect((await request('POST')).json().groups[1].history.run.id).toBe(runId);
 expect(calls).toHaveLength(before);expect((await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows).toHaveLength(2);
},30000);
it('provider failure preserves local data and cools down rather than polling new source requests',async()=>{
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second' WHERE id=${runId}::uuid`.execute(database.db);fail=true;
 const response=await request('POST');const id=response.json().groups[1].history.run.id;expect(id).not.toBe(runId);
 let data;for(let i=0;i<100;i++){data=(await request('GET')).json();if(data.groups[1].history.run.finishedAt)break;await new Promise(r=>setTimeout(r,100));}
 expect(data.groups[1].history.run.status).toBe('error');expect(data.groups[1].history.retryAt).not.toBeNull();
 const before=calls.length;expect((await request('POST')).json().groups[1].history.run.id).toBe(id);expect(calls).toHaveLength(before);
 expect((await sql`SELECT id FROM matches WHERE id>=99000000`.execute(database.db)).rows).toHaveLength(2);expect((await boss.getJobById(PLAYER_HISTORY_QUEUE,old))?.state).toBe('created');
},30000);
it('a missing account affects one side only, and viewer reads never promote an unrelated pending job',async()=>{
 const data=(await request('POST',{lineupA:['1','2','3','4','999'],lineupB:b})).json();expect(data.groups[0]).toMatchObject({state:'unavailable',history:null});expect(data.groups[1].history.run).not.toBeNull();
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
 const before=calls.length;await request('GET',{lineupA:other,lineupB:b});expect(calls).toHaveLength(before);expect((await boss.getJobById(PLAYER_HISTORY_QUEUE,old))?.priority).toBe(0);
 await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);
});
