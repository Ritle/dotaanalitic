import {beforeAll,afterAll,test,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {sql,registrySha,ScenarioRepository,type Executor} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedDraft,draftInput} from '../../../tests/helpers/draft.js';
import {DraftCaptureRepository} from '../src/modules/scenarios/draft-capture-repository.js';
import {DraftHistoryRepository} from '../src/modules/scenarios/draft-history-repository.js';
import {DraftShadowRepository} from '../src/modules/scenarios/draft-shadow-repository.js';
import {calculateDraftShadow} from '../src/modules/scenarios/draft-shadow-runtime.js';
import {AuthService} from '../src/modules/auth/service.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,app:FastifyInstance,cookie:string,csrf:string;
beforeAll(async()=>{
  database=await testDatabase();await seedDraft(database.db);
  const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-shadow-persistence',password)).id;
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-shadow-persistence',password}});
  const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},60000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
async function scenario(){const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1})));
  return new ScenarioRepository(database.db).save(owner,q);}
async function captured(){const s=await scenario();const c=await new DraftCaptureRepository(database.db).create(owner,s.id,{expectedRevision:1});return {s,c};}
const post=(url:string,payload:unknown={})=>app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});

test('HTTP capture automatically stores one private result and a separate receipt; response has no scores',async()=>{
  const s=await scenario(),url=`/api/v1/scenarios/${s.id}/draft-captures`,r=await post(url,{expectedRevision:1});
  expect(r.statusCode).toBe(200);expect(r.json()).not.toHaveProperty('researchScores');
  const rows=(await sql<{writer_txid:string;observer_txid:string;at:string;recorded:string}>`SELECT r.writer_txid,p.observer_txid,
    p.observed_committed_at::text AS at,r.recorded_at::text AS recorded FROM owner_draft_shadow_runs r JOIN owner_draft_shadow_receipts p ON p.run_id=r.id
    WHERE r.capture_id=${r.json().id}::uuid`.execute(database.db)).rows;
  expect(rows).toHaveLength(1);expect(rows[0]!.writer_txid).not.toBe(rows[0]!.observer_txid);expect(rows[0]!.at>=rows[0]!.recorded).toBe(true);
  const summary=await app.inject({method:'GET',url:url+'/1/shadow-summary',headers:{cookie}});
  expect(summary.statusCode).toBe(200);expect(summary.json()).toMatchObject({status:'unavailable',primaryEligible:false,teamAWinProbability:null});
  expect(summary.json()).not.toHaveProperty('researchScores');expect(summary.json()).not.toHaveProperty('candidate');
  expect((await sql`SELECT id FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('concurrent retries persist exactly once and never reload a changed candidate',async()=>{
  const {s,c}=await captured();let calls=0;const repo=new DraftShadowRepository(database.db,async()=>{calls++;return null;});
  const results=await Promise.all([repo.ensure(owner,s.id,1),repo.ensure(owner,s.id,1)]);expect(results[0]).toEqual(results[1]);expect(calls).toBe(1);
  const later=new DraftShadowRepository(database.db,async()=>{throw Error('must_not_recompute');});expect(await later.ensure(owner,s.id,1)).toEqual(results[0]);
  expect((await sql`SELECT id FROM owner_draft_shadow_runs WHERE capture_id=${c.id}::uuid`.execute(database.db)).rows).toHaveLength(1);
});
test('crash after result commit is recovered by observing the same bytes in a later transaction',async()=>{
  const {s}=await captured(),repo=new DraftShadowRepository(database.db,async()=>null),run=await repo.persistResult(owner,s.id,1);
  expect((await repo.summary(owner,s.id,1)).status).toBe('awaiting_receipt');
  const retry=new DraftShadowRepository(database.db,async()=>{throw Error('must_not_recompute');}),result=await retry.ensure(owner,s.id,1);
  expect(result.sha256).toBe(run.sha256);expect(result.observedCommittedAt!>=run.recordedAt).toBe(true);
  expect((await repo.summary(owner,s.id,1)).status).toBe('unavailable');
});
async function insertInside(tx:Executor,s:Awaited<ReturnType<typeof scenario>>,c:Awaited<ReturnType<DraftCaptureRepository['create']>>){
  const observation=await new DraftHistoryRepository(database.db).get(owner,s.id,1,tx);
  const at=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;
  const result=calculateDraftShadow(c,observation,null,at,'a'.repeat(64)),text=JSON.stringify(result),id=randomUUID(),hash=registrySha(text);
  await sql`INSERT INTO owner_draft_shadow_runs(id,capture_id,owner_user_id,result_text,result_sha256,writer_txid)
    VALUES(${id}::uuid,${c.id}::uuid,${owner}::uuid,${text},${hash},'forged')`.execute(tx);return {id,hash};
}
test('same transaction and savepoint cannot masquerade as a post-commit receipt',async()=>{
  for(const subtransaction of [false,true]){
    const {s,c}=await captured();
    await expect(database.db.transaction().execute(async tx=>{
      if(subtransaction)await sql`SAVEPOINT synthetic_subtransaction`.execute(tx);
      const r=await insertInside(tx,s,c);
      if(subtransaction)await sql`RELEASE SAVEPOINT synthetic_subtransaction`.execute(tx);
      await sql`INSERT INTO owner_draft_shadow_receipts(run_id,result_sha256,observer_txid) VALUES(${r.id}::uuid,${r.hash},'forged')`.execute(tx);
    })).rejects.toThrow('draft_shadow_commit_not_observed');
    expect((await sql`SELECT id FROM owner_draft_shadow_runs WHERE capture_id=${c.id}::uuid`.execute(database.db)).rows).toHaveLength(0);
  }
});
test('results and receipts reject update, delete and truncate',async()=>{
  const {s}=await captured();await new DraftShadowRepository(database.db,async()=>null).ensure(owner,s.id,1);
  for(const name of ['owner_draft_shadow_receipts','owner_draft_shadow_runs']){
    await expect(sql`DELETE FROM ${sql.table(name)}`.execute(database.db)).rejects.toThrow('immutable');
    await expect(sql`TRUNCATE ${sql.table(name)} CASCADE`.execute(database.db)).rejects.toThrow('immutable');
  }
  await expect(sql`UPDATE owner_draft_shadow_runs SET result_sha256=${'a'.repeat(64)}`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`UPDATE owner_draft_shadow_receipts SET observed_committed_at=clock_timestamp()`.execute(database.db)).rejects.toThrow('immutable');
});
test('read is side-effect free; owner boundary, CSRF and strict retry input are enforced',async()=>{
  const {s,c}=await captured(),base=`/api/v1/scenarios/${s.id}/draft-captures/1`,repo=new DraftShadowRepository(database.db,async()=>null);
  expect((await repo.summary(owner,s.id,1)).status).toBe('missing');
  expect((await sql`SELECT id FROM owner_draft_shadow_runs WHERE capture_id=${c.id}::uuid`.execute(database.db)).rows).toHaveLength(0);
  await expect(repo.ensure(randomUUID(),s.id,1)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await app.inject({method:'GET',url:base+'/shadow-summary'})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:base+'/shadow-retry',headers:{cookie,origin:'http://localhost:5173'},payload:{}})).statusCode).toBe(403);
  expect((await post(base+'/shadow-retry',{calculatedAt:'2020-01-01'})).statusCode).toBe(400);
  await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
  try{expect((await post(base+'/shadow-retry')).statusCode).toBe(403);expect((await app.inject({method:'GET',url:base+'/shadow-summary',headers:{cookie}})).statusCode).toBe(403);}
  finally{await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);}
});
