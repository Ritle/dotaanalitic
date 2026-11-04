import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedPredictionScenario} from '../../../tests/helpers/predictions.js';
import {sql,ScenarioRepository,V1RuntimeRepository,V1TargetLifecycleRepository,V1JournalRepository,V1JournalService} from '../src/index.js';
import {registrySha,registryHash} from '../src/v1-registry.js';
import {buildV1Journal} from '../src/v1-journal.js';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,requestId:string,peerRequestId:string,whatIfId:string;
let lifecycle:V1TargetLifecycleRepository,journal:V1JournalRepository;
let oldReport:Awaited<ReturnType<V1JournalRepository['get']>>;
const request=(action:'cancelled'|'reopened'='cancelled',expectedRevision=0)=>({requestId:randomUUID(),predictionRequestId:requestId,
  action,expectedRevision,eventAt:null,sourceUrl:'https://example.test/synthetic-cancellation',reason:'Synthetic owner reviewed cancellation'});
beforeAll(async()=>{
  database=await testDatabase();lifecycle=new V1TargetLifecycleRepository(database.db);journal=new V1JournalRepository(database.db);
  const input=await seedPredictionScenario(database.db);
  owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash) VALUES('synthetic-lifecycle',${'x'.repeat(40)}) RETURNING id`.execute(database.db)).rows[0]!.id;
  // Persist a legacy v1 record through SQL029, then read it after later lifecycle changes.
  const empty=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  const legacyInput={format:'v1-journal-input-v1',capturedAt:empty.input.capturedAt,code:empty.input.code,observations:[]};
  const inputText=JSON.stringify(legacyInput),legacyRequest={requestId:randomUUID(),filters:empty.report.request.filters};
  const report={...empty.report,format:'v1-journal-report-v1',request:legacyRequest,revision:2,previousSha256:empty.sha256,
    inputSha256:registrySha(inputText),summary:buildV1Journal(legacyInput,{})},reportText=JSON.stringify(report);
  await sql`INSERT INTO v1_journal_reports(owner_user_id,request_id,request_hash,revision,previous_sha256,captured_at,input_text,input_sha256,report_text,report_sha256)
    VALUES(${owner},${legacyRequest.requestId},${registryHash(legacyRequest)},2,${empty.sha256},${empty.input.capturedAt}::timestamptz,
      ${inputText},${registrySha(inputText)},${reportText},${registrySha(reportText)})`.execute(database.db);
  oldReport=await journal.get(owner,legacyRequest.requestId);
  const s=await new ScenarioRepository(database.db).save(owner,input),runtime=new V1RuntimeRepository(database.db);
  const base={scenarioId:s.id,expectedRevision:s.revision,purpose:'real_map',targetScope:null,
    realTarget:{provider:'opendota',providerSeriesId:'9007199254742999',mapNumber:1,sourceUrl:'https://example.test/synthetic',rationale:'Synthetic explicit first-map target'}};
  requestId=randomUUID();peerRequestId=randomUUID();whatIfId=randomUUID();
  for(const id of [requestId,peerRequestId])await runtime.create(owner,{...base,requestId:id});
  await runtime.create(owner,{requestId:whatIfId,scenarioId:s.id,expectedRevision:s.revision,purpose:'what_if_single_map',targetScope:null});
},60000);
afterAll(async()=>{await database?.close();},30000);
it('requires a real owned target, valid transition and non-future evidence without writing failures',async()=>{
  await expect(lifecycle.append(randomUUID(),request())).rejects.toThrow('NOT_FOUND');
  await expect(lifecycle.append(owner,{...request(),predictionRequestId:whatIfId})).rejects.toThrow('NOT_FOUND');
  await expect(lifecycle.append(owner,request('reopened'))).rejects.toThrow('lifecycle_invalid_transition');
  await expect(lifecycle.append(owner,{...request(),eventAt:'2100-01-01T00:00:00.000Z'})).rejects.toThrow('lifecycle_future_event');
  await expect(lifecycle.append(owner,{...request(),winner:'A'})).rejects.toThrow();
  expect((await lifecycle.history(owner,requestId)).items).toHaveLength(0);
});
it('serializes duplicate requests, shares target state across recalculations and preserves originals',async()=>{
  const req=request(),[a,b]=await Promise.all([lifecycle.append(owner,req),lifecycle.append(owner,req)]);expect(b).toEqual(a);
  expect((await lifecycle.history(owner,peerRequestId)).items).toEqual([a]);
  await expect(lifecycle.append(owner,{...req,reason:'Changed synthetic reason'})).rejects.toThrow('lifecycle_request_conflict');
  await expect(lifecycle.append(owner,request())).rejects.toThrow('CONFLICT');
  await expect(lifecycle.append(owner,request('cancelled',1))).rejects.toThrow('lifecycle_invalid_transition');
  const saved=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  expect(saved.report.summary.counts).toMatchObject({attempts:3,cancelled:1,unavailable:2,whatIfAttempts:1});expect(saved.report.summary.metrics.n).toBe(0);
  const service=await V1JournalService.open(database.db),view=await service.get(owner,saved.report.request.requestId);
  expect(view.rows.filter(r=>r.status==='cancelled')).toHaveLength(2);expect(view.rows.find(r=>r.status==='cancelled')?.lifecycle?.sha256).toBe(a.sha256);
  expect(JSON.stringify(view)).not.toContain('ownerId');
  await lifecycle.append(owner,request('reopened',1));
  expect(await journal.get(owner,saved.report.request.requestId)).toEqual(saved);
  const reopened=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  expect(reopened.report.summary.counts.cancelled).toBe(0);expect(reopened.report.summary.rows.filter(r=>r.status==='unavailable')).toHaveLength(2);
  expect(await journal.get(owner,oldReport.report.request.requestId)).toEqual(oldReport);
  expect((await service.get(owner,oldReport.report.request.requestId)).summary.counts.cancelled).toBeNull();
  expect((await lifecycle.history(owner,requestId,2)).items.map(r=>r.event.revision)).toEqual([1]);
});
it('rejects concurrent stale transitions and direct mutation or forged lifecycle events',async()=>{
  const attempts=await Promise.allSettled([lifecycle.append(owner,request('cancelled',2)),lifecycle.append(owner,request('cancelled',2))]);
  expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(r=>r.status==='rejected')).toHaveLength(1);
  for(const statement of [sql`UPDATE v1_target_lifecycle SET revision=999`,sql`DELETE FROM v1_target_lifecycle`,sql`TRUNCATE v1_target_lifecycle`])
    await expect(statement.execute(database.db)).rejects.toThrow();
  const latest=(await lifecycle.history(owner,requestId)).items[0]!,forged={...latest.event,revision:4,previousSha256:latest.sha256,
    request:{...request('reopened',3),predictionRequestId:whatIfId}},text=JSON.stringify(forged);
  await expect(sql`INSERT INTO v1_target_lifecycle(owner_user_id,provider_series_id,map_number,revision,request_id,request_hash,event_text,event_sha256)
    VALUES(${owner},${latest.event.target.providerSeriesId},1,4,${forged.request.requestId},${registryHash(forged.request)},${text},${registrySha(text)})`.execute(database.db)).rejects.toThrow('lifecycle_target_required');
});
it('requires complete current lifecycle inventory at the SQL report boundary',async()=>{
  const saved=await journal.create(owner,{requestId:randomUUID(),filters:{status:'cancelled'}});
  expect(saved.report.summary.counts).toMatchObject({attempts:2,cancelled:1});
  const input={...saved.input,lifecycle:[]},inputText=JSON.stringify(input),req={...saved.report.request,requestId:randomUUID()};
  const r={...saved.report,request:req,revision:saved.revision+1,previousSha256:saved.sha256,inputSha256:registrySha(inputText)},text=JSON.stringify(r);
  await expect(sql`INSERT INTO v1_journal_reports(owner_user_id,request_id,request_hash,revision,previous_sha256,captured_at,input_text,input_sha256,report_text,report_sha256)
    VALUES(${owner},${req.requestId},${registryHash(req)},${r.revision},${saved.sha256},${input.capturedAt}::timestamptz,
      ${inputText},${registrySha(inputText)},${text},${registrySha(text)})`.execute(database.db)).rejects.toThrow('journal_lifecycle_inventory');
});
it('owner CLI appends an idempotent reopening and reads its history without accepting outcomes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'v1-lifecycle-'));
  const cli=(args:string[])=>spawnSync(process.execPath,['scripts/v1-target-lifecycle.mjs',...args],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,DATABASE_URL:database.url},encoding:'utf8',windowsHide:true,timeout:20000});
  try{
    const path=join(dir,'request.json'),text=JSON.stringify(request('reopened',3));await writeFile(path,text);
    const first=cli(['append',path,registrySha(text)]);expect(first.status,first.stderr).toBe(0);
    const retry=cli(['append',path,registrySha(text)]);expect(retry.status,retry.stderr).toBe(0);expect(retry.stdout).toBe(first.stdout);
    const history=cli(['history',requestId]);expect(history.status,history.stderr).toBe(0);
    expect(JSON.parse(history.stdout).items.map((r:{event:{revision:number}})=>r.event.revision)).toEqual([4,3,2,1]);
    const invalid=JSON.stringify({...request('cancelled',4),winner:'private-synthetic-value'});await writeFile(path,invalid);
    const rejected=cli(['append',path,registrySha(invalid)]);expect(rejected.status).toBe(1);expect(rejected.stderr).not.toContain('private-synthetic-value');
  }finally{const target=resolve(dir);if(!target.startsWith(resolve(tmpdir())+sep))throw Error('unsafe_test_cleanup');await rm(target,{recursive:true,force:true});}
},90000);
