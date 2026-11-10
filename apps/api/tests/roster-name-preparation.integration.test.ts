import {createHash,randomBytes} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,afterEach,test,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PlayerCatalogueRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../tests/helpers/upcoming';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
import {AuthService} from '../src/modules/auth/service';

let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string;
let registryNames=['Thiolicor'],searchNames=['Thiolicor'],calls:string[]=[];
const observation=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{endpoint,fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
beforeAll(async()=>{
 database=await testDatabase();const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-name-boundary',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,PANDASCORE_API_TOKEN:scheduleToken}),{db:database.db,logger:false,
  catalogueProvider:async(key,query)=>{calls.push(key);return key==='registry'?observation('/proPlayers',registryNames.map((name,i)=>({account_id:1001+i,steamid:String(76561197960265728n+1001n+BigInt(i)),name,team_id:71,team_name:'Synthetic'}))):
   observation('/search?q='+encodeURIComponent(query??''),searchNames.map((personaname,i)=>({account_id:2001+i,personaname})));},
  pandascoreFetch:async url=>{if(!url.pathname.endsWith('/rosters'))return Response.json(syntheticSchedule());const r=syntheticRosters();r.rosters.forEach((t,i)=>{t.players=i===0?[{...t.players[0]!,name:'Oli'}]:[];});return Response.json(r);}});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-name-boundary',password}});
 const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
 for(const url of ['/api/v1/upcoming/refresh','/api/v1/upcoming/tournaments/71001/refresh'])expect((await app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{}})).statusCode).toBe(200);
},30000);
beforeEach(async()=>{await sql`DELETE FROM roster_catalogue_cache`.execute(database.db);calls=[];registryNames=['Thiolicor'];searchNames=['Thiolicor'];});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await app?.close();await database?.close();},30000);
const prepare=async(externalSearch:boolean)=>{
 const r=await app.inject({method:'POST',url:'/api/v1/upcoming/70001/catalogue/prepare',headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{externalSearch}});
 expect(r.statusCode,r.body).toBe(200);return r.json().teams[0].players[0];
};
test('a substring in a registry nickname is not an automatic account suggestion',async()=>{
 expect(await prepare(false)).toMatchObject({status:'source_unavailable',reason:'external_search_deferred',candidates:[]});
 expect(calls).toEqual(['registry']);
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM players`.execute(database.db)).rows[0]!.n).toBe(0);
});
test('a partial local name must not hide an exact registry candidate',async()=>{
 registryNames=['Oli'];vi.spyOn(PlayerCatalogueRepository.prototype,'search').mockResolvedValue([{id:'3001',name:'Thiolicor',teamId:null,teamName:null,localPlayerId:'3001',proMaps:100}]);
 expect(await prepare(false)).toMatchObject({status:'suggested',candidates:[{id:'1001',name:'Oli'}]});expect(calls).toEqual(['registry']);
});
test('external discovery obeys the same boundary; decorated exact names remain reviewable and cached',async()=>{
 searchNames=['Thiolicor','SYN.Oli','Oli'];const p=await prepare(true);
 expect(p).toMatchObject({status:'suggested',candidates:[{id:'2003',name:'Oli'}]});
 expect(calls).toHaveLength(2);expect(await prepare(true)).toEqual(p);expect(calls).toHaveLength(2);
});
