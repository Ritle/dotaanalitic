import {randomBytes} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {ScenarioSnapshotSchema,DraftAssessmentSchema} from '@dota/contracts';
import {sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedDraft,draftInput,draftRule} from '../../../tests/helpers/draft.js';
import {scenarioInput} from '../../../tests/helpers/scenario.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string;
const url='/api/v1/scenarios',check=url+'/draft-check';
beforeEach(async()=>{
  database=await testDatabase();await seedDraft(database.db);const password=randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-draft',password);app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-draft',password}});
  const c=r.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=r.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
const send=(path:string,payload:unknown=draftInput(),method:'POST'|'PUT'='POST')=>app.inject({method,url:path,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});
const get=(path:string)=>app.inject({method:'GET',url:path,headers:{cookie}});
test('preview is owner/CSRF/no-store protected and creates no scenario, fact or model',async()=>{
  expect((await app.inject({method:'POST',url:check,payload:draftInput()})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:check,headers:{cookie,origin:'http://localhost:5173'},payload:draftInput()})).statusCode).toBe(403);
  const r=await send(check);expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(DraftAssessmentSchema.parse(r.json()).predictionStatus).toBe('unavailable');
  expect((await sql`SELECT * FROM scenarios`.execute(database.db)).rows).toHaveLength(0);expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('zero, partial and complete draft persist native role assignments and unordered bans atomically',async()=>{
  const empty=ScenarioSnapshotSchema.parse((await send(url)).json());expect(empty.draftAssessment?.assignedHeroes).toBe(0);
  const q=draftInput();q.draft={assignments:Array.from({length:10},(_,i)=>({teamSlot:i<5?'A':'B',rolePos:i%5+1,heroId:i+1})),bans:[{teamSlot:'A',heroId:11}]};
  const r=await send(`${url}/${empty.id}`,{expectedRevision:1,input:q},'PUT');expect(r.statusCode).toBe(200);const s=ScenarioSnapshotSchema.parse(r.json());
  expect(s.draftAssessment).toMatchObject({fullDraft:true,assignedHeroes:10,predictionStatus:'unavailable',teamAWinProbability:null,status:'unknown'});
  const rows=(await sql<{team_slot:string;role_pos:number;hero_id:number}>`SELECT team_slot,role_pos,hero_id FROM scenario_lineup WHERE scenario_id=${s.id}::uuid ORDER BY team_slot,role_pos`.execute(database.db)).rows;
  expect(rows[0]).toEqual({team_slot:'A',role_pos:1,hero_id:1});expect(rows[5]).toEqual({team_slot:'B',role_pos:1,hero_id:6});
  expect((await sql`SELECT * FROM scenario_bans WHERE scenario_id=${s.id}::uuid`.execute(database.db)).rows).toHaveLength(1);
  expect((await sql`SELECT * FROM scenario_draft_actions`.execute(database.db)).rows).toHaveLength(0);
  q.draft.assignments=q.draft.assignments.slice(0,2);q.draft.bans=[];expect((await send(`${url}/${s.id}`,{expectedRevision:2,input:q},'PUT')).statusCode).toBe(200);
  expect((await sql`SELECT * FROM scenario_bans`.execute(database.db)).rows).toHaveLength(0);
});
test('duplicate cross-team hero, duplicate slot, ban overlap and unknown hero fail without revision changes',async()=>{
  const s=(await send(url)).json(),q=draftInput();
  for(const draft of [{assignments:[{teamSlot:'A',rolePos:1,heroId:1},{teamSlot:'B',rolePos:1,heroId:1}],bans:[]},
    {assignments:[{teamSlot:'A',rolePos:1,heroId:1}],bans:[{teamSlot:'B',heroId:1}]},
    {assignments:[{teamSlot:'A',rolePos:1,heroId:2147483647}],bans:[]}])expect((await send(`${url}/${s.id}`,{expectedRevision:1,input:{...q,draft}},'PUT')).statusCode).toBe(400);
  expect((await get(`${url}/${s.id}`)).json().revision).toBe(1);
});
test('reviewed deny blocks direct save and returns blocked preview; unknown and late deny are not fabricated allowed',async()=>{
  const q=draftInput();q.draft!.assignments=[{teamSlot:'A',rolePos:1,heroId:1}];await draftRule(database.db,1,false);
  expect((await send(check,q)).json()).toMatchObject({status:'blocked',heroes:[{decision:{value:false}}]});
  const r=await send(url,q);expect(r.statusCode).toBe(422);expect(r.json().error.code).toBe('DRAFT_UNAVAILABLE');expect((await get(url)).json().items).toHaveLength(0);
  q.draft!.assignments[0]!.heroId=2;await draftRule(database.db,2,false,{knownAt:'2026-01-01T00:00:00.000Z'});
  const late=ScenarioSnapshotSchema.parse((await send(url,q)).json());expect(late.draftAssessment?.heroes[0]?.decision.value).toBeNull();expect(late.draftAssessment?.status).toBe('unknown');
});
test('registry corrections change new decisions, never frozen old assessment; blocked update rolls back every projection',async()=>{
  const q=draftInput();q.draft!.assignments=[{teamSlot:'B',rolePos:5,heroId:1}];await draftRule(database.db,1,true);
  const old=ScenarioSnapshotSchema.parse((await send(url,q)).json());expect(old.draftAssessment?.status).toBe('available');
  await draftRule(database.db,2,false);q.title='Must roll back';q.draft!.assignments[0]!.heroId=2;
  expect((await send(`${url}/${old.id}`,{expectedRevision:1,input:q},'PUT')).statusCode).toBe(422);
  expect((await get(`${url}/${old.id}`)).json()).toEqual(old);
  await draftRule(database.db,1,false);q.draft!.assignments[0]!.heroId=1;
  const preview=DraftAssessmentSchema.parse((await send(check,q)).json());expect(preview.status).toBe('unknown');expect(preview.heroes[0]?.decision.reason).toBe('CONFLICT');
  const next=ScenarioSnapshotSchema.parse((await send(`${url}/${old.id}`,{expectedRevision:1,input:q},'PUT')).json());expect(next.revision).toBe(2);expect(next.draftAssessment?.registryRevision).not.toBe(old.draftAssessment?.registryRevision);
  expect((await get(`${url}/${old.id}/history`)).json().items[1]).toEqual(old);
  await expect(sql`UPDATE scenario_input_snapshots SET draft_assessment='{}' WHERE scenario_id=${old.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
});
test('legacy history unchanged; old clients cannot silently erase picks/bans; explicit empty draft clears',async()=>{
  const legacy=ScenarioSnapshotSchema.parse((await send(url,scenarioInput())).json());expect(legacy).not.toHaveProperty('draftAssessment');
  const q=draftInput();q.draft={assignments:[{teamSlot:'A',rolePos:1,heroId:1}],bans:[{teamSlot:'B',heroId:2}]};
  expect((await send(`${url}/${legacy.id}`,{expectedRevision:1,input:q},'PUT')).statusCode).toBe(200);
  expect((await send(`${url}/${legacy.id}`,{expectedRevision:2,input:scenarioInput()},'PUT')).statusCode).toBe(409);
  expect((await send(`${url}/${legacy.id}`,{expectedRevision:2,input:draftInput()},'PUT')).statusCode).toBe(200);
  expect((await get(`${url}/${legacy.id}/history`)).json().items[2]).toEqual(legacy);
  expect((await sql`SELECT * FROM scenario_lineup WHERE hero_id IS NOT NULL`.execute(database.db)).rows).toHaveLength(0);
});
test('swapping two heroes changes player-role association and input hash; stale draft updates reject',async()=>{
  const q=draftInput();q.draft!.assignments=[{teamSlot:'A',rolePos:1,heroId:1},{teamSlot:'A',rolePos:2,heroId:2}];const old=(await send(url,q)).json();
  [q.draft!.assignments[0]!.heroId,q.draft!.assignments[1]!.heroId]=[2,1];const next=(await send(`${url}/${old.id}`,{expectedRevision:1,input:q},'PUT')).json();
  expect(next.inputHash).not.toBe(old.inputHash);expect(next.input.draft.assignments).toEqual(q.draft!.assignments);
  expect((await send(`${url}/${old.id}`,{expectedRevision:1,input:q},'PUT')).statusCode).toBe(409);
});
test('unknown league/catalog and injected assessment reject; source decisions require known map time',async()=>{
  const q=draftInput();q.context.leagueId='999999';expect((await send(check,q)).statusCode).toBe(400);
  q.context.leagueId='1';q.scheduledAt=null;q.draft!.assignments=[{teamSlot:'A',rolePos:1,heroId:1}];await draftRule(database.db,1,false);
  expect((await send(check,q)).json()).toMatchObject({status:'unknown',mapTime:null,heroes:[{decision:{value:null}}]});
  expect((await send(url,{...q,draftAssessment:{status:'available'}})).statusCode).toBe(400);
});
