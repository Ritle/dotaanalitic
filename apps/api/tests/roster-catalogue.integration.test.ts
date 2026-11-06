import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {IdentityRepository,RosterCatalogueRepository,PlayerCatalogueRepository,sql} from '@dota/db';
import {RosterCatalogueBindingSchema} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../tests/helpers/roster-catalogue';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,rosterSha:string,failSource=false,failCalls=0,rosterRequests=0,changedRoster=false;
const fixture=syntheticCatalogue(),route='/api/v1/upcoming/70001/catalogue';
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(suffix:string,payload:unknown)=>app.inject({method:'POST',url:route+'/'+suffix,headers:headers(),payload});
const input=()=>({requestId:randomUUID(),providerTeamId:'74001',teamId:'71',expectedRevision:0,rosterSha256:rosterSha,
 registrySha256:fixture.registry.source.payloadSha256,players:Array.from({length:5},(_,i)=>({providerPlayerId:String(75001+i),accountId:String(1001+i)})),confirmedByOwner:true});
beforeAll(async()=>{
 database=await testDatabase();const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-bridge',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,PANDASCORE_API_TOKEN:scheduleToken}),{db:database.db,logger:false,catalogueProvider:async (key,query)=>{if(failSource){failCalls++;throw new Error('synthetic-source-failure');}return fixture.provider(key,query);},
  pandascoreFetch:async url=>{if(!url.pathname.endsWith('/rosters'))return Response.json(syntheticSchedule());rosterRequests++;const r=syntheticRosters();r.rosters.forEach((t,i)=>t.players.forEach((p,j)=>{p.name=fixture.players[i*6+j]!.name;}));if(changedRoster)r.rosters[0]!.players.pop();return Response.json(r);}});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-bridge',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
 for(const url of ['/api/v1/upcoming/refresh','/api/v1/upcoming/tournaments/71001/refresh'])expect((await app.inject({method:'POST',url,headers:headers(),payload:{}})).statusCode).toBe(200);
 rosterSha=(await app.inject({url:route,headers:{cookie}})).json().rosterSha256;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
test('authentication, CSRF and cached state do not make provider requests',async()=>{
 expect((await app.inject({url:route})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:route+'/search',headers:{cookie},payload:{kind:'players',query:'Synthetic'}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:route+'/prepare',headers:{cookie},payload:{}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:route+'/prepare',payload:{}})).statusCode).toBe(401);
 const state=(await app.inject({url:route,headers:{cookie}})).json();expect(state.teams[0].players).toHaveLength(6);expect(state.teams[0].binding).toBeNull();expect(fixture.calls).toEqual([]);
});
test('batch preparation distinguishes ambiguous accounts and reuses one registry observation',async()=>{
 const r=await post('prepare',{});expect(r.statusCode,r.body).toBe(200);
 expect(r.json().teams[0].players[0].status).toBe('ambiguous');
 expect(r.json().teams[0].players[0].candidates.map((p:{id:string})=>p.id)).toEqual(['1001','1007']);
 expect(r.json().teams[0].players[2].status).toBe('suggested');
 expect(fixture.calls).toEqual(['registry']);
});
test('one registry fetch serves every search, ambiguous names keep distinct IDs',async()=>{
 const r=await post('search',{kind:'players',query:'Synthetic Twin'});expect(r.statusCode).toBe(200);expect(r.json().items.map((p:{id:string})=>p.id)).toEqual(['1001','1007']);
 await post('search',{kind:'teams',query:'Synthetic'});await post('search',{kind:'players',query:'1002'});expect(fixture.calls).toEqual(['registry','directory']);
});

test('automatic preparation defers external name search and validates the option',async()=>{
 const cache=(await sql<{payload:unknown}>`SELECT payload FROM upcoming_source_cache WHERE cache_key='tournament:71001'`.execute(database.db)).rows[0]!.payload;
 const count=fixture.calls.length;
 try{
  await sql`UPDATE upcoming_source_cache SET payload=jsonb_set(payload,'{data,0,players,1,name}','"Synthetic unknown deferred player"') WHERE cache_key='tournament:71001'`.execute(database.db);
  const r=await post('prepare',{externalSearch:false});expect(r.statusCode,r.body).toBe(200);
  expect(r.json().teams[0].players[1]).toMatchObject({status:'source_unavailable',reason:'external_search_deferred',candidates:[]});expect(fixture.calls).toHaveLength(count);
  await sql`UPDATE upcoming_source_cache SET payload=jsonb_set(payload,'{data,0,players,1,name}','"86"') WHERE cache_key='tournament:71001'`.execute(database.db);
  const numeric=await post('prepare',{externalSearch:false});expect(numeric.statusCode).toBe(200);
  expect(numeric.json().teams[0].players[1]).toMatchObject({status:'source_unavailable',candidates:[]});expect(fixture.calls).toHaveLength(count);
  expect((await post('prepare',{externalSearch:'false'})).statusCode).toBe(400);
 }finally{await sql`UPDATE upcoming_source_cache SET payload=${JSON.stringify(cache)}::jsonb WHERE cache_key='tournament:71001'`.execute(database.db);}
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
 expect((await post('apply',q)).json()).toEqual(saved);expect(fixture.calls).toEqual(['registry','directory','team:71']);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(5);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM player_account_evidence WHERE event_at IS NULL AND known_at=fetched_at`.execute(database.db)).rows[0]!.n).toBe(5);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM role_profile_bindings`.execute(database.db)).rows[0]!.n).toBe(1);
 await expect(sql`UPDATE expected_roster_catalogue_bindings SET revision=2`.execute(database.db)).rejects.toThrow('expected_roster_catalogue_immutable');
 expect((await post('apply',{...q,teamId:'72'})).statusCode).toBe(409);
 expect((await post('apply',input())).statusCode).toBe(409);
});
test('global decisions survive team transfer and nickname changes without provider calls',async()=>{
 const cache=(await sql<{payload:unknown}>`SELECT payload FROM upcoming_source_cache WHERE cache_key='tournament:71001'`.execute(database.db)).rows[0]!.payload;
 await sql`UPDATE upcoming_source_cache SET payload=jsonb_set(jsonb_set(payload,'{data,1,players,0,providerPlayerId}','"75001"'::jsonb),'{data,1,players,0,name}','"Renamed after transfer"'::jsonb) WHERE cache_key='tournament:71001'`.execute(database.db);
 const count=fixture.calls.length,r=await post('prepare',{});expect(r.statusCode,r.body).toBe(200);
 expect(r.json().teams[1].players[0]).toMatchObject({providerPlayerId:'75001',status:'linked',candidates:[{id:'1001',localPlayerId:saved.players[0]!.playerId}]});expect(fixture.calls).toHaveLength(count);
 await sql`UPDATE upcoming_source_cache SET payload=${JSON.stringify(cache)}::jsonb WHERE cache_key='tournament:71001'`.execute(database.db);
});
test('known local alias remains searchable during provider outage and corrections reject stale link tokens',async()=>{
 const owner=(await sql<{id:string}>`SELECT id FROM app_users WHERE login='synthetic-bridge'`.execute(database.db)).rows[0]!.id,repo=new PlayerCatalogueRepository(database.db);
 const at=new Date().toISOString();await new IdentityRepository(database.db).appendAlias({playerId:saved.players[0]!.playerId,alias:'Synthetic former nickname',source:'synthetic',evidenceRef:'synthetic alias',eventAt:null,knownAt:at,fetchedAt:at});
 failSource=true;const count=failCalls,r=await post('search',{kind:'players',query:'Synthetic former nickname'});failSource=false;
 expect(r.statusCode).toBe(200);expect(r.json().source).toBe('local');expect(r.json().items[0]).toMatchObject({id:'1001',localPlayerId:saved.players[0]!.playerId,proMaps:0});expect(failCalls).toBe(count);
 const q={...input(),expectedRevision:1,players:input().players.map((p,i)=>({...p,...(i===0?{linkToken:'0'.repeat(64)}:{})}))};
 expect((await post('apply',q)).statusCode).toBe(409);
 const link=await repo.link(owner,'75001');expect(link.rows).toHaveLength(1);expect(link.rows[0]!.accountId).toBe('1001');
 await expect(sql`UPDATE provider_player_links SET account_id='199'`.execute(database.db)).rejects.toThrow('expected_roster_catalogue_immutable');
});
test('external discovery coalesces repeated queries and never provisions before numeric profile review',async()=>{
 const before=(await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n;
 const rs=await Promise.all([post('search',{kind:'players',query:'Synthetic undiscovered'}),post('search',{kind:'players',query:'Synthetic undiscovered'})]);
 expect(rs.every(r=>r.statusCode===200)).toBe(true);expect(rs[0]!.json().items[0]).toMatchObject({id:'199',discovery:true});
 expect(fixture.calls.filter(k=>k.startsWith('search:'))).toHaveLength(1);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(before);
});
test('a team absent from proPlayers is discoverable and selectable independently of stale player membership',async()=>{
 const r=await post('search',{kind:'teams',query:'New team without registered members'});expect(r.statusCode,r.body).toBe(200);
 expect(r.json().items.map((p:{id:string})=>p.id)).toEqual(['703']);expect(r.json().sourceEndpoint).toBe('/teams');
 const byId=await post('search',{kind:'teams',query:'703'});expect(byId.json().items[0].id).toBe('703');
 const q={...input(),providerTeamId:'74002',teamId:'703',players:Array.from({length:5},(_,i)=>({providerPlayerId:String(75011+i),accountId:String(1007+i)}))};
 const savedB=await post('apply',q);expect(savedB.statusCode,savedB.body).toBe(200);expect(savedB.json().teamName).toBe('New team without registered members');
 const calls=fixture.calls.length;await post('search',{kind:'teams',query:'New team without registered members'});expect(fixture.calls).toHaveLength(calls);
});
test('Panda organization works without any OpenDota team profile and preserves numeric player verification',async()=>{
 const q={...input(),providerTeamId:'74002',teamId:'74002',teamProvider:'pandascore',expectedRevision:1,
  players:Array.from({length:5},(_,i)=>({providerPlayerId:String(75011+i),accountId:String(1007+i)}))};
 const calls=fixture.calls.length,r=await post('apply',q);expect(r.statusCode,r.body).toBe(200);
 expect(r.json().source.team).toMatchObject({provider:'pandascore',externalTeamId:'74002'});expect(r.json().players.every((p:{identityStatus:string})=>p.identityStatus==='verified')).toBe(true);
 expect((await sql`SELECT opendota_team_id FROM teams WHERE id=${r.json().teamId}`.execute(database.db)).rows[0]!.opendota_team_id).toBeNull();
 expect((await post('apply',q)).json()).toEqual(r.json());expect(fixture.calls).toHaveLength(calls);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM provider_team_catalogue`.execute(database.db)).rows[0]!.n).toBe(1);
 await expect(sql`UPDATE provider_team_catalogue SET external_team_id=999`.execute(database.db)).rejects.toThrow('provider_team_catalogue_immutable');
 expect((await post('apply',{...q,requestId:randomUUID(),expectedRevision:2,teamId:'71'})).statusCode).toBe(400);
});
test('saved numeric organization proof is reused with a local five without network or a duplicate team',async()=>{
 const state=(await app.inject({url:route,headers:{cookie}})).json(),a=state.teams[0].binding;
 const q={...input(),expectedRevision:a.revision,registrySha256:null,players:a.players.map((p:{providerPlayerId:string;accountId:string;playerId:string})=>({providerPlayerId:p.providerPlayerId,accountId:p.accountId,localPlayerId:p.playerId}))};
 await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE source_key='team:71'`.execute(database.db);
 const count=failCalls,teams=(await sql<{n:number}>`SELECT count(*)::int n FROM teams`.execute(database.db)).rows[0]!.n;failSource=true;
 const r=await post('apply',q);failSource=false;expect(r.statusCode,r.body).toBe(200);expect(failCalls).toBe(count);
 expect(r.json().teamId).toBe(a.teamId);expect(r.json().source.team).toEqual(a.source.team);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM teams`.execute(database.db)).rows[0]!.n).toBe(teams);
});
test('explicit profile search is cached and mixed five saves separate immutable numeric evidence',async()=>{
 const r=await post('search',{kind:'players',query:'https://stratz.com/players/199?utm_source=twitch'});expect(r.statusCode,r.body).toBe(200);
 const p=r.json();expect(p.sourceEndpoint).toBe('/players/199');expect(p.items[0]).toMatchObject({id:'199',name:'Synthetic new nickname 199'});expect(p.registrySha256).toBe(fixture.registry.source.payloadSha256);
 await post('search',{kind:'players',query:'199'});expect(fixture.calls.filter(k=>k==='player:199')).toHaveLength(1);
 const players=Array.from({length:5},(_,i)=>({providerPlayerId:String(75011+i),accountId:String(1007+i),...(i===0?{accountId:'199',profileSha256:p.payloadSha256}:{})}));
 const q={...input(),providerTeamId:'74002',teamId:'74002',teamProvider:'pandascore',expectedRevision:2,players};
 const before=(await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n;
 expect((await post('apply',{...q,players:players.map((v,i)=>i===0?{...v,profileSha256:'0'.repeat(64)}:v)})).statusCode).toBe(409);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(before);
 const saved=await post('apply',q);expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().players[0].identityStatus).toBe('verified');
 expect(saved.json().source.profiles).toEqual([{accountId:'199',payloadSha256:p.payloadSha256,fetchedAt:p.fetchedAt}]);
 expect((await post('apply',q)).json()).toEqual(saved.json());
 const evidence=(await sql`SELECT source,known_at=fetched_at AS current FROM player_account_evidence WHERE external_account_id='199'`.execute(database.db)).rows;
 expect(evidence).toHaveLength(1);expect(evidence[0]).toMatchObject({source:'reviewed-current-profile-v1:https://api.opendota.com/api/players/199',current:true});
});
test('mismatched profile is rejected with cooldown and arbitrary links never trigger profile fetch',async()=>{
 const before=fixture.calls.length;
 expect((await post('search',{kind:'players',query:'https://evil.test/players/199'})).json().items).toEqual([]);expect(fixture.calls).toHaveLength(before);
 for(let i=0;i<2;i++)expect((await post('search',{kind:'players',query:'198'})).statusCode).toBe(503);
 expect(fixture.calls.filter(k=>k==='player:198')).toHaveLength(1);
});
test('five profile accounts can create a verified organization without pretending registry membership',async()=>{
 const players=[];for(let i=0;i<5;i++){const r=await post('search',{kind:'players',query:String(200+i)});expect(r.statusCode,r.body).toBe(200);players.push({providerPlayerId:String(75011+i),accountId:String(200+i),profileSha256:r.json().payloadSha256});}
 const q={...input(),providerTeamId:'74002',teamId:'704',expectedRevision:3,players};
 const r=await post('apply',q);expect(r.statusCode,r.body).toBe(200);expect(r.json().source.profiles).toHaveLength(5);expect(r.json().teamName).toBe('Profile-only organization');
 expect(r.json().players.every((p:{identityStatus:string})=>p.identityStatus==='verified')).toBe(true);
});
test('saving refreshes a stale identical roster once, while changed source bytes require review',async()=>{
 // Only this disposable mock-source DB: quota waiting is covered separately, not part of the stale-roster assertion.
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity' WHERE singleton`.execute(database.db);
 const count=rosterRequests;await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE cache_key='tournament:71001'`.execute(database.db);
 const q={...input(),expectedRevision:2},r=await post('apply',q);expect(r.statusCode,r.body).toBe(200);expect(r.json().revision).toBe(3);expect(rosterRequests).toBe(count+1);
 changedRoster=true;await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity' WHERE singleton`.execute(database.db);
 await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE cache_key='tournament:71001'`.execute(database.db);
 const changed=await post('apply',{...input(),expectedRevision:3});expect(changed.statusCode).toBe(409);expect(changed.json().error.code).toBe('CATALOGUE_SOURCE_CHANGED');expect(rosterRequests).toBe(count+2);changedRoster=false;
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
 for(let i=0;i<2;i++){const r=await post('search',{kind:'players',query:'Unindexed synthetic'});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({items:[],warning:'source_unavailable'});expect(r.body).not.toContain('synthetic-source-failure');}
 expect(failCalls).toBe(2);
});
test('an entire verified local five saves without registry or profile access and validates its canonical IDs',async()=>{
 const state=(await app.inject({url:route,headers:{cookie}})).json(),b=state.teams[1].binding;
 const count=failCalls,q={...input(),providerTeamId:'74002',teamId:'74002',teamProvider:'pandascore',expectedRevision:b.revision,rosterSha256:state.rosterSha256,registrySha256:null,
  players:b.players.map((p:{providerPlayerId:string;accountId:string;playerId:string})=>({providerPlayerId:p.providerPlayerId,accountId:p.accountId,localPlayerId:p.playerId}))};
 const forged={...q,players:q.players.map((p:{localPlayerId:string},i:number)=>i===0?{...p,localPlayerId:'999999'}:p)};
 expect((await post('apply',forged)).statusCode).toBe(409);
 const r=await post('apply',q);expect(r.statusCode,r.body).toBe(200);expect(r.json().source.provider).toBe('local');expect(failCalls).toBe(count);
 const search=await post('search',{kind:'players',query:'Synthetic Player 8'});expect(search.statusCode).toBe(200);expect(search.json().items.some((p:{id:string})=>p.id==='201')).toBe(true);
});
test('explicit global correction invalidates an older team five without rewriting its snapshot',async()=>{
 const owner=(await sql<{id:string}>`SELECT id FROM app_users WHERE login='synthetic-bridge'`.execute(database.db)).rows[0]!.id;
 const repo=new RosterCatalogueRepository(database.db),links=new PlayerCatalogueRepository(database.db),b=(await repo.latest(owner,'74002'))!;
 const transfer={...input(),providerTeamId:'999',teamId:'999',teamProvider:'pandascore' as const,registrySha256:null,players:b.players.map(p=>({providerPlayerId:p.providerPlayerId,accountId:p.accountId,localPlayerId:p.playerId})),confirmedByOwner:true as const};
 const old=await repo.save(owner,transfer,{...b,providerTeamId:'999',revision:1,recordedAt:new Date().toISOString()});expect(old.usable).toBe(true);
 const state=(await app.inject({url:route,headers:{cookie}})).json(),players=[];
 for(const [i,p] of b.players.entries())players.push({providerPlayerId:p.providerPlayerId,accountId:i===0?'1003':p.accountId,localPlayerId:i===0?saved.players[2]!.playerId:p.playerId,linkToken:(await links.link(owner,p.providerPlayerId)).token});
 const r=await post('apply',{...input(),providerTeamId:'74002',teamId:'74002',teamProvider:'pandascore',expectedRevision:b.revision,registrySha256:null,rosterSha256:state.rosterSha256,players});
 expect(r.statusCode,r.body).toBe(200);expect((await repo.latest(owner,'999'))!.usable).toBe(false);
 expect((await repo.latest(owner,'999'))!.players[0]!.accountId).toBe('200');expect((await links.link(owner,players[0]!.providerPlayerId)).rows[0]!.accountId).toBe('1003');
});
test('conflicting legacy team decisions remain ambiguous instead of choosing the last team',async()=>{
 const owner=(await sql<{id:string}>`SELECT id FROM app_users WHERE login='synthetic-bridge'`.execute(database.db)).rows[0]!.id;
 const repo=new RosterCatalogueRepository(database.db),b=(await repo.latest(owner,'74002'))!;
 for(const [i,team] of ['997','998'].entries()){
  const players=b.players.map((p,j)=>j===0?{...p,providerPlayerId:'999001',...(i?{accountId:'200'}:{})}:p),requestId=randomUUID();
  const binding={...b,providerTeamId:team,players,revision:1};
  await sql`INSERT INTO expected_roster_catalogue_bindings(owner_user_id,request_id,provider_team_id,team_id,revision,request,binding)
   VALUES(${owner}::uuid,${requestId}::uuid,${team},${b.teamId},1,'{}'::jsonb,${JSON.stringify(binding)}::jsonb)`.execute(database.db);
 }
 const link=await new PlayerCatalogueRepository(database.db).link(owner,'999001');expect(link.rows.map(r=>r.accountId).sort()).toEqual(['1003','200']);
 expect((await repo.latest(owner,'997'))!.usable).toBe(false);expect((await repo.latest(owner,'998'))!.usable).toBe(false);
});
test('numeric local lookup follows verified account evidence even without a legacy primary account column',async()=>{
 await sql`UPDATE players SET opendota_account_id=NULL WHERE id=${saved.players[2]!.playerId}`.execute(database.db);
 const before=failCalls,r=await post('search',{kind:'players',query:'https://stratz.com/players/1003'});
 expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({source:'local',items:[{id:'1003',localPlayerId:saved.players[2]!.playerId}]});expect(failCalls).toBe(before);
});
test('Unicode aliases are case insensitive even when the database default locale is C',async()=>{
 const at=new Date().toISOString();await new IdentityRepository(database.db).appendAlias({playerId:saved.players[2]!.playerId,alias:'Синтетический Кириллический Ник',source:'synthetic',evidenceRef:'synthetic unicode alias',eventAt:null,knownAt:at,fetchedAt:at});
 const before=failCalls,r=await post('search',{kind:'players',query:'синтетический кириллический ник'});
 expect(r.statusCode,r.body).toBe(200);expect(r.json().items[0].id).toBe('1003');expect(failCalls).toBe(before);
});

test('ambiguous local profiles prefer completed pro history without treating pubs or future maps as pro evidence',async()=>{
 const at=new Date().toISOString(),identity=new IdentityRepository(database.db),withHistory=saved.players[3]!,withoutHistory=saved.players[2]!;
 for(const player of [withHistory,withoutHistory])await identity.appendAlias({playerId:player.playerId,alias:'Synthetic disputed history',source:'synthetic',evidenceRef:'synthetic history ranking',eventAt:null,knownAt:at,fetchedAt:at});
 await sql`INSERT INTO heroes(id,localized_name,internal_name) VALUES(99001,'Synthetic rank hero','synthetic_rank_hero')`.execute(database.db);
 await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,source,ingest_state) VALUES
  (99001,clock_timestamp()-interval '1 day',60,true,true,'synthetic','accepted'),
  (99002,clock_timestamp()-interval '1 day',60,true,false,'synthetic','accepted'),
  (99003,clock_timestamp()+interval '1 day',60,true,true,'synthetic','accepted')`.execute(database.db);
 for(const [match,player] of [['99001',withHistory],['99002',withoutHistory],['99003',withoutHistory]] as const)await sql`INSERT INTO match_players(match_id,player_slot,side,player_id,hero_id,source_account_id) VALUES(${match},0,'radiant',${player.playerId},99001,${player.accountId})`.execute(database.db);
 const before=fixture.calls.length,r=await post('search',{kind:'players',query:'Synthetic disputed history'});
 expect(r.statusCode,r.body).toBe(200);expect(r.json().items.map((p:{id:string})=>p.id)).toEqual([withHistory.accountId,withoutHistory.accountId]);
 expect(r.json().items.map((p:{proMaps:number})=>p.proMaps)).toEqual([1,0]);expect(fixture.calls).toHaveLength(before);
 // An explicit account ID cannot be redirected to a different alias with more history.
 await identity.appendAlias({playerId:withHistory.playerId,alias:withoutHistory.accountId,source:'synthetic',evidenceRef:'synthetic numeric alias',eventAt:null,knownAt:at,fetchedAt:at});
 const numeric=await post('search',{kind:'players',query:withoutHistory.accountId});expect(numeric.statusCode).toBe(200);
 expect(numeric.json().items.map((p:{id:string})=>p.id)).toEqual([withoutHistory.accountId]);
});
