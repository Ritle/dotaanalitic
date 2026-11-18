import {test,expect,beforeEach,afterEach} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../tests/helpers/postgres';
import {sql} from '../../../packages/db/src/index';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';
import {LineupTemplateRepository} from '../src/modules/catalog/lineup-templates-repository';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,owner:{id:string;login:string};
const origin='http://localhost:5173',url='/api/v1/teams/9007199254740993/lineup-template';
const lineup=()=>Array.from({length:5},(_,i)=>({playerId:String(9007199254741010n+BigInt(i)),rolePos:i+1}));
const input=()=>({requestId:randomUUID(),expectedRevision:0,confirmedByOwner:true as const,lineup:lineup()});
const request=(method:'GET'|'POST',path:string,payload?:unknown)=>app.inject({method,url:path,headers:{cookie,origin,'x-csrf-token':csrf},...(payload===undefined?{}:{payload})});
beforeEach(async()=>{
 database=await testDatabase();await sql`INSERT INTO teams(id,name) VALUES(9007199254740993,'Synthetic Template Team')`.execute(database.db);
 for(const p of lineup())await sql`INSERT INTO players(id,nickname) VALUES(${p.playerId},'Synthetic template player')`.execute(database.db);
 const password=randomBytes(24).toString('base64url');owner=await new AuthService(database.db).provision('synthetic-template-owner',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:origin}),{db:database.db,logger:false});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{login:owner.login,password}});
 expect(login.statusCode,login.body).toBe(200);cookie=login.cookies.map(c=>c.name+'='+c.value).join('; ');csrf=login.json().csrfToken;
});
afterEach(async()=>{await app?.close();await database?.close();});
test('private template access and owner capabilities preserve CSRF/origin guards',async()=>{
 expect((await app.inject({url})).statusCode).toBe(401);expect((await request('GET','/api/v1/auth/access')).json()).toEqual({role:'owner',canManageLineups:true});
 expect((await request('GET',url)).json().current).toBeNull();
 expect((await app.inject({method:'POST',url,headers:{cookie,origin},payload:input()})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url,headers:{cookie,origin:'https://synthetic-invalid.test','x-csrf-token':csrf},payload:input()})).statusCode).toBe(403);
});
test('owner save is shared, author-stamped, idempotent and append-only',async()=>{
 const body=input(),saved=await request('POST',url,body);expect(saved.statusCode,saved.body).toBe(200);const r=saved.json();expect(r).toMatchObject({teamId:'9007199254740993',revision:1,lineup:lineup(),confirmedBy:owner});expect(Date.parse(r.confirmedAt)).toBeLessThanOrEqual(Date.now());
 expect((await request('POST',url,body)).json()).toEqual(r);expect((await request('POST',url,{...body,requestId:body.requestId.toUpperCase()})).json()).toEqual(r);expect((await request('GET',url)).json().current).toEqual(r);
 await expect(sql`UPDATE owner_lineup_templates SET revision=2`.execute(database.db)).rejects.toThrow('owner_lineup_template_immutable');
 await expect(sql`DELETE FROM owner_lineup_templates`.execute(database.db)).rejects.toThrow('owner_lineup_template_immutable');
 expect((await sql`SELECT id FROM owner_lineup_templates`.execute(database.db)).rows).toHaveLength(1);
});
test('duplicate/missing players or roles, unknown records and client-supplied authority are rejected',async()=>{
 const good=input();for(const lineup of [good.lineup.slice(1),good.lineup.map(p=>({...p,playerId:good.lineup[0]!.playerId})),good.lineup.map(p=>({...p,rolePos:1})),good.lineup.map((p,i)=>i?p:{...p,rolePos:0})])expect((await request('POST',url,{...good,lineup})).statusCode).toBe(400);
 expect((await request('POST',url,{...good,lineup:good.lineup.map((p,i)=>i?p:{...p,playerId:'77'})})).statusCode).toBe(400);
 expect((await request('POST',url,{...good,ownerId:owner.id,role:'owner'})).statusCode).toBe(400);
 expect((await request('POST','/api/v1/teams/77/lineup-template',good)).statusCode).toBe(404);
});
test('concurrent writes use shared-team CAS and request reuse cannot overwrite another revision',async()=>{
 const a=input(),b={...input(),lineup:lineup().map(p=>({...p,rolePos:6-p.rolePos}))};
 const result=await Promise.all([request('POST',url,a),request('POST',url,b)]);expect(result.map(r=>r.statusCode).sort()).toEqual([200,409]);
 const old=(await request('GET',url)).json().current;const chosen=result[0]!.statusCode===200?a:b;
 expect((await request('POST',url,{...chosen,lineup:chosen.lineup.map(p=>({...p,rolePos:6-p.rolePos}))})).statusCode).toBe(409);
 const next=await request('POST',url,{...input(),expectedRevision:1});expect(next.statusCode,next.body).toBe(200);expect(next.json().revision).toBe(2);expect((await request('GET',url)).json().history[1]).toEqual(old);
});
test('the reserved user role can read shared templates but cannot mutate with an existing session or a forged owner flag',async()=>{
 const saved=(await request('POST',url,input())).json();await sql`UPDATE app_users SET account_role='user' WHERE id=${owner.id}::uuid`.execute(database.db);
 expect((await request('GET','/api/v1/auth/access')).json()).toEqual({role:'user',canManageLineups:false});expect((await request('GET',url)).json().current).toEqual(saved);
 for(const path of [url,'/api/v1/upcoming/77/catalogue/apply','/api/v1/teams/9007199254740993/role-profile-binding','/api/v1/scenarios']){
  const denied=await request('POST',path,{...input(),confirmedByOwner:true});expect(denied.statusCode,denied.body).toBe(403);expect(denied.json().error.code).toBe('OWNER_REQUIRED');
 }
 await expect(new LineupTemplateRepository(database.db).save(owner.id,'9007199254740993',input())).rejects.toMatchObject({code:'forbidden'});
 expect((await sql`SELECT id FROM owner_lineup_templates`.execute(database.db)).rows).toHaveLength(1);
 expect((await request('POST','/api/v1/auth/logout')).statusCode).toBe(204);
});
test('database validation refuses invalid roles and a demoted author even outside HTTP',async()=>{
 const insert=(rows:unknown)=>sql`INSERT INTO owner_lineup_templates(team_id,revision,owner_user_id,owner_login,request_id,lineup,request) VALUES(9007199254740993,1,${owner.id}::uuid,${owner.login},${randomUUID()}::uuid,${JSON.stringify(rows)}::jsonb,'{}'::jsonb)`.execute(database.db);
 await expect(insert(lineup().map(p=>({...p,rolePos:1})))).rejects.toThrow('owner_lineup_invalid_players_or_roles');
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner.id}::uuid`.execute(database.db);await expect(insert(lineup())).rejects.toThrow('owner_lineup_permission_denied');
});
