import {beforeAll,afterAll,test,expect,vi} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {createQueue,enqueue,registerWorker,deferJob,IMPORT_QUEUE} from '../src/queue.js';
import {OpenDotaError} from '@dota/ingestion';
import type {PgBoss} from 'pg-boss';

let fixture:Awaited<ReturnType<typeof testDatabase>>;
let boss:PgBoss;
beforeAll(async()=>{fixture=await testDatabase();boss=await createQueue(fixture.url,'pgboss',0);},60000);
afterAll(async()=>{await boss?.stop({graceful:true,timeout:10000});await fixture?.close();},30000);
async function waitFor(check:()=>Promise<boolean>){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('queue_test_timeout');}

test('pg-boss deduplicates a queued map and retains it after restart',async()=>{
  const id=await enqueue(boss,{matchId:'901'});expect(id).not.toBeNull();
  expect(await enqueue(boss,{matchId:'901'})).toBeNull();
  await boss.stop({graceful:true});boss=await createQueue(fixture.url,'pgboss',0);
  expect((await boss.getJobById(IMPORT_QUEUE,id!))?.state).toBe('created');
  await registerWorker(boss,fixture.db,async matchId=>({matchId,receiptId:'1',status:'partial',duplicate:true,dataRevision:'1'}));
  await waitFor(async()=>(await boss.getJobById(IMPORT_QUEUE,id!))?.state==='completed');
  await boss.offWork(IMPORT_QUEUE,{wait:true});
});
test('temporary worker errors retry and a replay uses the same logical map ID',async()=>{
  let attempts=0;
  const id=await enqueue(boss,{matchId:'902'});
  await registerWorker(boss,fixture.db,async matchId=>{
    if(++attempts===1)throw new Error('synthetic transient database failure');
    return {matchId,receiptId:'2',status:'partial',duplicate:true,dataRevision:'1'};
  });
  await waitFor(async()=>(await boss.getJobById(IMPORT_QUEUE,id!))?.state==='completed');
  expect(attempts).toBe(2);
  await boss.offWork(IMPORT_QUEUE,{wait:true});
});
test('Retry-After atomically completes the attempt and creates a durable future job',async()=>{
  const id=await enqueue(boss,{matchId:'903'});
  await registerWorker(boss,fixture.db,async()=>{throw new OpenDotaError('source_rate_limited','/matches/903',429,120000);});
  await waitFor(async()=>(await boss.getJobById(IMPORT_QUEUE,id!))?.state==='completed');
  await boss.offWork(IMPORT_QUEUE,{wait:true});
  const jobs=await boss.findJobs(IMPORT_QUEUE,{singletonKey:'903'});
  expect(jobs.some(job=>job.state==='created')).toBe(true);
  const future=jobs.find(job=>job.state==='created')!;
  expect((await boss.getJobById(IMPORT_QUEUE,id!))?.output).toMatchObject({status:'deferred',nextJobId:future.id});
  expect(future.startAfter.getTime()-Date.now()).toBeGreaterThan(100000);
  await boss.stop({graceful:true});boss=await createQueue(fixture.url,'pgboss',0);
  expect((await boss.getJobById(IMPORT_QUEUE,future.id))?.state).toBe('created');
});
test('a failed atomic deferral rolls back completion; permanent source failures go to failed state',async()=>{
  const id=await enqueue(boss,{matchId:'904'});
  const [job]=await boss.fetch(IMPORT_QUEUE,{batchSize:1});
  expect(job?.id).toBe(id);
  const failure=vi.spyOn(boss,'send').mockRejectedValueOnce(new Error('synthetic queue write failure'));
  try{await expect(deferJob(boss,fixture.db,job!,{matchId:'904'},1000)).rejects.toThrow('synthetic queue write failure');}
  finally{failure.mockRestore();}
  expect((await boss.getJobById(IMPORT_QUEUE,id!))?.state).toBe('active');
  await boss.fail(IMPORT_QUEUE,job!,{code:'synthetic_retry'});
  await registerWorker(boss,fixture.db,async()=>{throw new OpenDotaError('source_http_error','/matches/904',404);});
  await waitFor(async()=>(await boss.getJobById(IMPORT_QUEUE,id!))?.state==='failed');
  await boss.offWork(IMPORT_QUEUE,{wait:true});
});
