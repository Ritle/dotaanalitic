import {createHash,randomBytes} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {IdentityRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';
const teamA='9007199254740993',teamB='9007199254740994',unlinkedTeam='9007199254740995';
const pid=(n:number)=>String(9007199254741010n+BigInt(n));
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,calls=0,transfer=false,fail=false;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const get=(kind:string,id:string)=>app.inject({url:`/api/v1/${kind}/${id}/roster-context`,headers:{cookie}});
const refresh=(kind:string,id:string)=>app.inject({method:'POST',url:`/api/v1/${kind}/${id}/roster-context/refresh`,headers:headers(),payload:{}});
beforeAll(async()=>{
 database=await testDatabase();await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES(${teamA},'Synthetic Alpha',71),(${teamB},'Synthetic Beta',72),(${unlinkedTeam},'Synthetic unlinked',NULL)`.execute(database.db);
 for(let i=1;i<=6;i++)await sql`INSERT INTO players(id,nickname,opendota_account_id) VALUES(${pid(i)},${i<=2?'Same nickname':'Synthetic '+i},${1000+i})`.execute(database.db);
 await sql`UPDATE players SET opendota_account_id=99999 WHERE id=${pid(1)}`.execute(database.db);
 const evidence=new IdentityRepository(database.db);
 for(const [player,account] of [[1,1001],[2,1002],[4,1004],[5,1004],[6,1006]])await evidence.appendAccountEvidence({playerId:pid(player!),externalAccountId:String(account),provider:'opendota',status:'verified',
  eventAt:null,knownAt:null,fetchedAt:'2026-01-01T00:00:00.000Z',evidenceRef:'synthetic:current-account',source:'synthetic'});
 const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-roster-context',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false,catalogueProvider:async key=>{
  expect(key).toBe('registry');calls++;if(fail)throw Error('synthetic-private-provider-error');
  const rawBody=JSON.stringify([1001,1002,1003,1004,1005].map(account_id=>({account_id,steamid:String(76561197960265728n+BigInt(account_id)),
   name:account_id<=1002?'Same nickname':'Synthetic '+account_id,team_id:account_id===1002||account_id===1001&&transfer?72:71,team_name:account_id===1002||account_id===1001&&transfer?'Synthetic Beta':'Synthetic Alpha'})));
  return {rawBody,source:{endpoint:'/proPlayers',fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};
 }});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-roster-context',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
beforeEach(async()=>{await sql`DELETE FROM roster_catalogue_cache`.execute(database.db);calls=0;transfer=false;fail=false;});
afterAll(async()=>{await app?.close();await database?.close();},30000);

test('empty cache is explicit, private GET never calls a provider, refresh requires CSRF and strict input',async()=>{
 const r=await get('teams',teamA);expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({status:'source_missing',members:[],source:{status:'not_loaded'}});
 expect((await app.inject({url:`/api/v1/teams/${teamA}/roster-context`})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:`/api/v1/teams/${teamA}/roster-context/refresh`,headers:{cookie},payload:{}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:`/api/v1/teams/${teamA}/roster-context/refresh`,headers:headers(),payload:{force:true}})).statusCode).toBe(400);
 expect((await get('teams','not-an-id')).statusCode).toBe(400);expect((await get('teams','9999')).statusCode).toBe(404);expect(calls).toBe(0);
});
test('team and player cards agree by numeric identity; same nicknames never join people or teams',async()=>{
 const r=await refresh('teams',teamA);expect(r.statusCode,r.body).toBe(200);const q=r.json();expect(q.status).toBe('listed');expect(q.members).toHaveLength(4);
 expect(q.members.find((p:{accountId:string})=>p.accountId==='1001')).toMatchObject({playerId:pid(1),identityStatus:'verified',team:{id:teamA,providerTeamId:'71'}});
 expect(q.members.find((p:{accountId:string})=>p.accountId==='1003')).toMatchObject({playerId:null,identityStatus:'unknown'});
 expect(q.members.find((p:{accountId:string})=>p.accountId==='1004')).toMatchObject({playerId:null,identityStatus:'conflict'});
 expect((await get('players',pid(1))).json()).toMatchObject({accountId:'1001',team:{id:teamA,providerTeamId:'71'}});
 expect((await get('players',pid(2))).json().team).toMatchObject({id:teamB,providerTeamId:'72'});
 expect(q.source).toMatchObject({status:'ready',knownAt:null,eventAt:null});expect(calls).toBe(1);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(6);
});
test('unknown identities and unlinked organizations cannot trigger nickname-based source lookup',async()=>{
 for(const [kind,id] of [['players',pid(3)],['players',pid(4)],['teams',unlinkedTeam]]){
  const r=await refresh(kind!,id!);expect(r.statusCode).toBe(200);expect(r.json().canRefresh).toBe(false);expect(r.json().members).toEqual([]);
 }
 expect(calls).toBe(0);
});
test('parallel refreshes and subsequent team/player requests reuse the single shared registry cache',async()=>{
 const results=await Promise.all([refresh('teams',teamA),refresh('players',pid(1)),refresh('teams',teamB)]);
 expect(results.every(r=>r.statusCode===200&&r.json().source.status==='ready')).toBe(true);expect(calls).toBe(1);
 await refresh('players',pid(2));await get('teams',teamA);expect(calls).toBe(1);
});
test('a changed registry removes old membership from both views without changing canonical metadata',async()=>{
 await refresh('teams',teamA);await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 expect((await get('players',pid(1))).json().source.status).toBe('stale');transfer=true;
 expect((await refresh('players',pid(1))).json().team.id).toBe(teamB);
 expect((await get('teams',teamA)).json().members.some((p:{accountId:string})=>p.accountId==='1001')).toBe(false);
 expect((await get('teams',teamB)).json().members.some((p:{accountId:string})=>p.accountId==='1001')).toBe(true);
 expect(calls).toBe(2);expect((await sql<{nickname:string}>`SELECT nickname FROM players WHERE id=${pid(1)}`.execute(database.db)).rows[0]!.nickname).toBe('Same nickname');
});
test('provider failure keeps the last validated observation stale and honors retry cooldown',async()=>{
 await refresh('teams',teamA);await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);fail=true;
 const r=await refresh('teams',teamA);expect(r.json()).toMatchObject({status:'listed',source:{status:'stale',refreshFailed:true}});expect(r.json().members).toHaveLength(4);
 expect(r.body).not.toContain('synthetic-private-provider-error');expect(calls).toBe(2);await refresh('players',pid(1));expect(calls).toBe(2);
});
test('unknown membership and corrupted cache never become a current team or an empty true lineup',async()=>{
 await refresh('teams',teamA);expect((await get('players',pid(6))).json()).toMatchObject({status:'not_listed',team:null,members:[]});
 await sql`UPDATE roster_catalogue_cache SET observation=jsonb_set(observation,'{source,payloadSha256}',to_jsonb(${'0'.repeat(64)}::text))`.execute(database.db);
 expect((await get('teams',teamA)).json()).toMatchObject({status:'source_missing',members:[],source:{status:'unavailable',fetchedAt:null}});
 expect(calls).toBe(1);
 expect((await refresh('teams',teamA)).json()).toMatchObject({status:'listed',source:{status:'ready',refreshFailed:false}});expect(calls).toBe(2);
});
