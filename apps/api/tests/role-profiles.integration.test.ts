import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {RoleProfilesReportSchema} from '@dota/contracts';
import {IdentityRepository,RoleProfileRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedProMaps} from '../../../tests/helpers/pro-maps.js';
import {catalogPlayerId,catalogTeamId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,calls=0,failStratz=false;
const ids=Array.from({length:5},(_,i)=>String(BigInt(catalogPlayerId)+BigInt(i)));
const binding={stratzTeamId:'77',pandaTournamentId:'55',pandaTeamId:'88',pandaPlayers:ids.map((playerId,i)=>({playerId,providerPlayerId:String(2000+i)}))};
const route='/api/v1/lineup-role-profiles',link=`/api/v1/teams/${catalogTeamId}/role-profile-binding`;
const input={teamId:catalogTeamId,playerIds:ids,cutoffAt:'2024-01-03T00:00:00.000Z'};
beforeAll(async()=>{
 database=await testDatabase();await seedProMaps(database.db);const password=randomBytes(24).toString('base64url');
 await new AuthService(database.db).provision('synthetic-role-profiles',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,ROLE_PROFILES_ENABLED:'true',STRATZ_API_TOKEN:'synthetic-stratz-profile-token',PANDASCORE_API_TOKEN:'synthetic-panda-profile-token'}),{
  db:database.db,logger:false,roleProfileFetch:async(url,init)=>{calls++;
   if(String(url).includes('stratz')){if(failStratz)return new Response('{}',{status:503});const account=Number(String(init?.body).match(/steamAccountId:(\d+)/)?.[1]);
    return new Response(JSON.stringify({data:{player:{steamAccountId:account,steamAccount:{proSteamAccount:{id:account,name:'Synthetic',teamId:77,position:`POSITION_${account-999}`}}}}}));}
   return new Response(JSON.stringify({type:'Team',rosters:[{id:88,name:'Synthetic',players:ids.map((_,i)=>({id:2000+i,name:'Synthetic Twin',role:String(i+1)}))}]}));
  }});
 const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-role-profiles',password}});
 const cookies=r.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=r.json().csrfToken;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(payload:unknown=input)=>app.inject({method:'POST',url:route,headers:headers(),payload});
test('owner/CSRF and validated local team/players gate reads and refreshes before any provider request',async()=>{
 expect((await app.inject({method:'POST',url:route,payload:input})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:route,headers:{cookie},payload:input})).statusCode).toBe(403);
 for(const payload of [{...input,teamId:'99999'},{...input,playerIds:['99999']},{...input,playerIds:[ids[0],ids[0]]}])expect((await post(payload)).statusCode).toBe(400);
 expect(calls).toBe(0);
});
test('owner-reviewed bindings persist, exact replay is idempotent, stale writes conflict and records are immutable',async()=>{
 const payload={requestId:randomUUID(),expectedRevision:0,binding,confirmedByOwner:true};
 for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url:link,headers:headers(),payload});expect(r.statusCode).toBe(200);expect(r.json().revision).toBe(1);}
 expect((await app.inject({method:'POST',url:link,headers:headers(),payload:{...payload,requestId:randomUUID()}})).statusCode).toBe(409);
 expect((await app.inject({method:'POST',url:link,headers:headers(),payload:{...payload,confirmedByOwner:false}})).statusCode).toBe(400);
 await expect(sql`UPDATE role_profile_bindings SET revision=2`.execute(database.db)).rejects.toThrow('role_binding_immutable');
 expect((await sql<{n:string}>`SELECT count(*)::text n FROM role_profile_bindings`.execute(database.db)).rows[0]!.n).toBe('1');
});
test('cache-only query does not contact providers and keeps selected-team history as fallback',async()=>{
 const response=await post();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
 const r=RoleProfilesReportSchema.parse(response.json());expect(calls).toBe(0);expect(r.canAutoApply).toBe(false);
 expect(r.players[0]).toMatchObject({rolePos:1,historyScope:'selected_team',basis:'history_fallback'});
});
test('bounded single-profile refresh plus explicit Panda links reaches agreement; fresh cache avoids network on replay',async()=>{
 const response=await post({...input,refreshProfiles:true});expect(response.statusCode).toBe(200);
 const r=RoleProfilesReportSchema.parse(response.json());expect(r.canAutoApply).toBe(true);expect(r.players.map(p=>p.rolePos)).toEqual([1,2,3,4,5]);
 expect(calls).toBe(6);expect(r.sources.every(s=>s.status==='ready')).toBe(true);
 await post({...input,refreshProfiles:true});expect(calls).toBe(6);
 expect(response.body).not.toMatch(/synthetic-(stratz|panda)-profile-token/);
},30000);
test('stale provider is excluded while two remaining sources can agree; cooldown prevents retry loops',async()=>{
 await sql`UPDATE role_profile_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE source_key='stratz:player:1000'`.execute(database.db);failStratz=true;
 const r=RoleProfilesReportSchema.parse((await post({...input,refreshProfiles:true})).json());expect(r.canAutoApply).toBe(true);
 expect(r.players[0]!.candidates.find(c=>c.source==='stratz')?.eligible).toBe(false);
 expect(r.sources.find(s=>s.sourceKey==='stratz:player:1000')).toMatchObject({status:'stale',reason:'cooldown'});
 const count=calls;await post({...input,refreshProfiles:true});expect(calls).toBe(count);
 failStratz=false;
});
test('durable quota refuses 429 cooldown and identity conflicts never inherit an available current profile',async()=>{
 await sql`UPDATE role_profile_stratz_quota SET blocked_until=clock_timestamp()+interval '1 minute'`.execute(database.db);
 expect(await new RoleProfileRepository(database.db).claimStratz()).toBeGreaterThan(50000);
 await new IdentityRepository(database.db).appendAccountEvidence({playerId:ids[1]!,externalAccountId:'1000',provider:'opendota',status:'verified',
  eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),evidenceRef:'synthetic:conflicting-role-account',source:'synthetic'});
 const r=RoleProfilesReportSchema.parse((await post()).json());expect(r.players[0]!.identityStatus).toBe('conflict');expect(r.players[0]!.autoEligible).toBe(false);
 expect(r.players[0]!.candidates.filter(c=>c.source!=='pro_history').every(c=>!c.eligible)).toBe(true);
});
