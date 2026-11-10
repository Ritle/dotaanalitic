import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';
const a='9007199254740993',b='9007199254740994',c='9007199254740995';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const get=(path:string)=>app.inject({url:'/api/v1/'+path,headers:{cookie}});
const input=(revision=0,status='inactive')=>({requestId:randomUUID(),expectedRevision:revision,status,basis:'source',sourceUrl:'https://example.com/synthetic-announcement',note:'Synthetic owner-reviewed source',checkedAt:'2026-01-01T00:00:00.000Z',effectiveAt:null});
const save=(id:string,body:unknown)=>app.inject({method:'POST',url:`/api/v1/teams/${id}/activity`,headers:headers(),payload:body});
beforeAll(async()=>{
 database=await testDatabase();await sql`INSERT INTO teams(id,name) VALUES(${a},'Synthetic Same'),(${b},'Synthetic Same'),(${c},'Synthetic Zed')`.execute(database.db);
 const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-activity',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-activity',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(x=>x.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
test('missing activity is unknown and no-map teams stay visible',async()=>{
 const r=await get(`teams/${a}/activity`);expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({teamId:a,current:null,history:[],hasMore:false});
 const list=await get('team-directory');expect(list.statusCode,list.body).toBe(200);expect(list.json().items.map((x:{id:string})=>x.id)).toEqual([a,b,c]);expect(list.json().items.every((x:{activityStatus:string})=>x.activityStatus==='unknown')).toBe(true);
});
test('private strict routes reject unsafe sources, impossible clocks and CSRF',async()=>{
 expect((await app.inject({url:`/api/v1/teams/${a}/activity`})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:`/api/v1/teams/${a}/activity`,headers:{cookie},payload:input()})).statusCode).toBe(403);
 for(const patch of [{sourceUrl:'javascript:alert(1)'},{sourceUrl:'https://user:secret@example.com'},{sourceUrl:null},{checkedAt:'2999-01-01T00:00:00.000Z'},{effectiveAt:'2026-01-02T00:00:00.000Z'},{note:'x'},{extra:true}])expect((await save(a,{...input(),...patch})).statusCode).toBe(400);
 expect((await get('team-directory?activityView=bogus')).statusCode).toBe(400);expect((await get(`teams/${a}/activity?force=1`)).statusCode).toBe(400);
 expect((await get('teams/999/activity')).statusCode).toBe(404);
});
test('archive is filtered before pagination and exact identities remain separate; legacy API remains inclusive',async()=>{
 const r=await save(a,input());expect(r.statusCode,r.body).toBe(200);expect(r.json().revision).toBe(1);
 const list=(await get('team-directory?limit=1')).json();expect(list.items.map((x:{id:string})=>x.id)).toEqual([b]);expect(list.hasMore).toBe(true);
 expect((await get('team-directory?activityView=archived')).json().items.map((x:{id:string})=>x.id)).toEqual([a]);
 expect((await get('team-directory?activityView=all')).json().items).toHaveLength(3);
 expect((await get('teams')).json().items).toHaveLength(3);expect((await get(`teams/${a}`)).statusCode).toBe(200);
 expect((await get(`teams/${b}/activity`)).json().current).toBeNull();
});
test('concurrent idempotent replay writes once; stale revision and changed replay conflict',async()=>{
 const body=input(0,'active'),responses=await Promise.all([save(b,body),save(b,body)]);expect(responses.map(r=>r.statusCode)).toEqual([200,200]);
 expect(responses[0]!.json()).toEqual(responses[1]!.json());expect((await get(`teams/${b}/activity`)).json().history).toHaveLength(1);
 expect((await save(b,{...body,status:'inactive'})).statusCode).toBe(409);expect((await save(b,input())).statusCode).toBe(409);
 expect((await save(a,body)).statusCode).toBe(409);
 const competing=await Promise.all([save(c,input()),save(c,input())]);expect(competing.map(r=>r.statusCode).sort()).toEqual([200,409]);
});
test('returning to unknown restores visibility and preserves prior evidence and exact replay',async()=>{
 const old=(await get(`teams/${a}/activity`)).json().current,body={...input(1,'unknown'),basis:'owner',sourceUrl:null,note:'Needs a new source review'};
 const r=await save(a,body);expect(r.statusCode,r.body).toBe(200);expect(r.json().revision).toBe(2);
 const report=(await get(`teams/${a}/activity`)).json();expect(report.history).toHaveLength(2);expect(report.history[1]).toEqual(old);
 expect((await get('team-directory')).json().items.some((x:{id:string})=>x.id===a)).toBe(true);
 expect((await save(a,body)).json()).toEqual(r.json());
 await expect(sql`UPDATE team_activity_reviews SET status='active' WHERE team_id=${a}`.execute(database.db)).rejects.toThrow('team_activity_immutable');
 await expect(sql`DELETE FROM team_activity_reviews WHERE team_id=${a}`.execute(database.db)).rejects.toThrow('team_activity_immutable');
});
