import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {IdentityRepository,RosterCatalogueRepository,sql} from '@dota/db';
import {RosterCatalogueBindingSchema} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../tests/helpers/roster-catalogue';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,rosterSha:string,failSource=false,failCalls=0;
const fixture=syntheticCatalogue(),route='/api/v1/upcoming/70001/catalogue';
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(suffix:string,payload:unknown)=>app.inject({method:'POST',url:route+'/'+suffix,headers:headers(),payload});
const input=()=>({requestId:randomUUID(),providerTeamId:'74001',teamId:'71',expectedRevision:0,rosterSha256:rosterSha,
 registrySha256:fixture.registry.source.payloadSha256,players:Array.from({length:5},(_,i)=>({providerPlayerId:String(75001+i),accountId:String(1001+i)})),confirmedByOwner:true});
beforeAll(async()=>{
 database=await testDatabase();const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-bridge',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,PANDASCORE_API_TOKEN:scheduleToken}),{db:database.db,logger:false,catalogueProvider:async key=>{if(failSource){failCalls++;throw new Error('synthetic-source-failure');}return fixture.provider(key);},
  pandascoreFetch:async url=>new Response(JSON.stringify(url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()))});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-bridge',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
 for(const url of ['/api/v1/upcoming/refresh','/api/v1/upcoming/tournaments/71001/refresh'])expect((await app.inject({method:'POST',url,headers:headers(),payload:{}})).statusCode).toBe(200);
 rosterSha=(await app.inject({url:route,headers:{cookie}})).json().rosterSha256;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
test('authentication, CSRF and cached state do not make provider requests',async()=>{
 expect((await app.inject({url:route})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:route+'/search',headers:{cookie},payload:{kind:'players',query:'Synthetic'}})).statusCode).toBe(403);
 const state=(await app.inject({url:route,headers:{cookie}})).json();expect(state.teams[0].players).toHaveLength(6);expect(state.teams[0].binding).toBeNull();expect(fixture.calls).toEqual([]);
});
test('one registry fetch serves every search, ambiguous names keep distinct IDs',async()=>{
 const r=await post('search',{kind:'players',query:'Synthetic Twin'});expect(r.statusCode).toBe(200);expect(r.json().items.map((p:{id:string})=>p.id)).toEqual(['1001','1007']);
 await post('search',{kind:'teams',query:'Synthetic'});await post('search',{kind:'players',query:'1002'});expect(fixture.calls).toEqual(['registry']);
});
test('unknown accounts, duplicated selection, changed source and unconfirmed selection cannot provision',async()=>{
 const q=input();
 for(const bad of [{...q,confirmedByOwner:false},{...q,players:[q.players[0],q.players[0],...q.players.slice(2)]},{...q,providerTeamId:'999'}])expect((await post('apply',bad)).statusCode).toBe(400);
 expect((await post('apply',{...q,registrySha256:'0'.repeat(64)})).statusCode).toBe(409);
 expect((await post('apply',{...q,rosterSha256:'0'.repeat(64)})).statusCode).toBe(409);
 expect((await post('apply',{...q,players:q.players.map((p,i)=>i===0?{...p,accountId:'99999'}:p)})).statusCode).toBe(400);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(0);
});
let saved:ReturnType<typeof RosterCatalogueBindingSchema.parse>;
test('a concurrent preparation is rejected before catalogue writes and a released lease can be retried',async()=>{
 const owner=(await sql<{id:string}>`SELECT id FROM app_users WHERE login='synthetic-bridge'`.execute(database.db)).rows[0]!.id;
 const repo=new RosterCatalogueRepository(database.db),lease=await repo.prepareLease(owner,'74001');
 expect((await post('apply',input())).statusCode).toBe(409);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(0);
 await repo.releasePreparation(owner,'74001',lease);
});
test('selected five of six are provisioned idempotently with current numeric evidence and role bindings',async()=>{
 const q=input(),r=await post('apply',q);expect(r.statusCode,r.body).toBe(200);saved=RosterCatalogueBindingSchema.parse(r.json());
 expect(saved.players).toHaveLength(5);expect(saved.players.every(p=>p.proMaps===0&&p.identityStatus==='verified')).toBe(true);
 expect(saved.usable).toBe(true);expect(saved.source.fetchedAt).toBe(fixture.registry.source.fetchedAt);
 expect((await post('apply',q)).json()).toEqual(saved);expect(fixture.calls).toEqual(['registry','team:71']);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(5);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM player_account_evidence WHERE event_at IS NULL AND known_at=fetched_at`.execute(database.db)).rows[0]!.n).toBe(5);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM role_profile_bindings`.execute(database.db)).rows[0]!.n).toBe(1);
 await expect(sql`UPDATE expected_roster_catalogue_bindings SET revision=2`.execute(database.db)).rejects.toThrow('expected_roster_catalogue_immutable');
 expect((await post('apply',{...q,teamId:'72'})).statusCode).toBe(409);
 expect((await post('apply',input())).statusCode).toBe(409);
});
test('changing membership disables reuse and conflicting numeric evidence is never inherited',async()=>{
 const r=await app.inject({url:route,headers:{cookie}});expect(r.json().teams[0].binding.usable).toBe(true);
 await sql`UPDATE upcoming_source_cache SET payload=jsonb_set(payload,'{data,0,players}','[]'::jsonb) WHERE cache_key='tournament:71001'`.execute(database.db);
 expect((await app.inject({url:route,headers:{cookie}})).json().teams[0].binding.usable).toBe(false);
 await new IdentityRepository(database.db).appendAccountEvidence({playerId:saved.players[1]!.playerId,provider:'opendota',externalAccountId:'1001',status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),source:'synthetic',evidenceRef:'synthetic conflicting account'});
 const state=(await app.inject({url:route,headers:{cookie}})).json();expect(state.teams[0].binding.players.some((p:{identityStatus:string})=>p.identityStatus==='conflict')).toBe(true);
});
test('failed refresh has a durable cooldown and cannot leak provider error details',async()=>{
 await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE source_key='registry'`.execute(database.db);failSource=true;
 for(let i=0;i<2;i++){const r=await post('search',{kind:'players',query:'Synthetic'});expect(r.statusCode).toBe(503);expect(r.body).not.toContain('synthetic-source-failure');}
 expect(failCalls).toBe(1);
});
