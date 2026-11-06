import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { collectionManager } from '../../scripts/lib/v1-collection.mjs';
import { sha } from '../../scripts/lib/evaluation-discovery-files.mjs';

// Synthetic orchestration fixtures; provider/replay correctness is covered by the existing collector suites.
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'dota-collection-'));t.after(()=>{
  assert(root.startsWith(resolve(tmpdir())+sep+'dota-collection-'));return rm(root,{recursive:true,force:true});
 });
 const bundle=join(root,'bundle'),directory=join(root,'session');await mkdir(join(bundle,'frozen'),{recursive:true});
 const plan={fingerprint:'a'.repeat(64),testFromAt:'2099-11-20T00:00:00.000Z',request:{snapshotAt:'2099-12-02T00:00:00.000Z'}};
 const cfg={planPath:'frozen/plan.json',planSha256:'b'.repeat(64),cataloguePath:'frozen/catalogue.json',developmentPath:'frozen/development.json'};
 const cfgBytes=JSON.stringify(cfg);await writeFile(join(bundle,'frozen/config.json'),cfgBytes);
 let at='2099-11-21T00:00:00.000Z', blocked=null, failure=false, sourceStatus='discovered', corrupt=false;
 const calls=[];
 const run=async (_bundle,_script,args)=>{
  calls.push(args[0]);
  if(args[0]==='collect') {
   if(blocked) await blocked;
   const config=await readFile(args[1]),dest=args[2];await mkdir(dest);
   const manifest={configSha256:sha(config),ledger:{scope:{planFingerprint:plan.fingerprint},status:sourceStatus}};
   const bytes=JSON.stringify(manifest);await writeFile(join(dest,'manifest.json'),bytes);
   if(failure) throw Error('synthetic_interruption_after_manifest');
   return {exitCode:sourceStatus==='partial'?3:0,output:{manifestSha256:sha(bytes)}};
  }
  if(args[0]==='verify') {
   if(corrupt)throw Error('synthetic_replay_failure');
   assert.equal(sha(await readFile(join(args[2],'manifest.json'))),args[3]);
   return {exitCode:0,output:{status:'discovery_verified',sourceStatus,summary:{uniqueMaps:0}}};
  }
  if(args[0]==='merge') {
   const refs=JSON.parse(await readFile(args[2],'utf8'));const bytes=JSON.stringify({ledger:{status:sourceStatus},runs:refs});await writeFile(args[3],bytes);
   return {exitCode:0,output:{status:'discovery_merged',artifactSha256:sha(bytes),summary:{uniqueMaps:0}}};
  }
  assert.fail('unexpected command');
 };
 const manager=collectionManager({verifyBundle:async()=>({planText:JSON.stringify(plan)}),run,clock:()=>at});
 const init=await manager.init(bundle,sha(cfgBytes),'c'.repeat(64),directory);
 const args=[directory,init.collectionSha256];
 return {manager,args,directory,bundle,calls,setAt:v=>at=v,setFailure:v=>failure=v,setPartial:()=>sourceStatus='partial',
  setBlocked:v=>blocked=v,setCorrupt:v=>corrupt=v};
}
test('pre-window collection does not call a provider or consume a run; exact source deadline refuses new calls',async t=>{
 const f=await fixture(t);f.setAt('2099-11-19T23:59:59.999Z');
 assert.equal((await f.manager.collect(...f.args,1)).status,'not_started');assert.deepEqual(f.calls,[]);
 assert.deepEqual(await readdir(join(f.directory,'runs')),[]);
 f.setAt('2099-12-02T00:00:00.000Z');await assert.rejects(f.manager.collect(...f.args,1),/collection_source_deadline/);
 assert.deepEqual(f.calls,[]);
});
test('exact run retries reuse verified capture even after source deadline and never issue another collect',async t=>{
 const f=await fixture(t);await f.manager.collect(...f.args,1);f.setAt('2099-12-02T00:00:00.001Z');
 assert.equal((await f.manager.collect(...f.args,1)).status,'already_captured');assert.equal(f.calls.filter(c=>c==='collect').length,1);
 assert.equal((await f.manager.status(...f.args)).collectionComplete,false);
});
test('partial source runs remain in the full union and are not called ready for evaluation',async t=>{
 const f=await fixture(t);f.setPartial();await f.manager.collect(...f.args,1);await f.manager.collect(...f.args,2);
 const merged=await f.manager.merge(...f.args);assert.equal(merged.runs,2);assert.equal(merged.sourceStatus,'partial');assert.equal(merged.readyForEvaluation,false);
 assert.equal(JSON.parse(await readFile(merged.unionPath,'utf8')).runs.length,2);
});
test('simultaneous commands cannot initiate duplicate provider requests or reclaim a live lock',async t=>{
 const f=await fixture(t);let release;f.setBlocked(new Promise(r=>release=r));const first=f.manager.collect(...f.args,1);
 while(!f.calls.includes('collect'))await new Promise(r=>setTimeout(r,5));
 await assert.rejects(f.manager.collect(...f.args,1),/collection_busy/);await assert.rejects(f.manager.recover(...f.args),/collection_busy/);
 release();await first;assert.equal(f.calls.filter(c=>c==='collect').length,1);
});
test('interruption after a complete manifest is recovered without HTTP; original failed record is immutable',async t=>{
 const f=await fixture(t);f.setFailure(true);await assert.rejects(f.manager.collect(...f.args,1),/collection_recovery_required/);
 const path=join(f.directory,'runs/01/result.json'),original=await readFile(path);
 await assert.rejects(f.manager.collect(...f.args,2),/collection_recovery_required/);
 assert.equal((await f.manager.recover(...f.args)).runs,1);assert.deepEqual(await readFile(path),original);
 assert.equal((await f.manager.status(...f.args)).runs[0].failedAttemptPreserved,true);
 assert.equal((await f.manager.merge(...f.args)).runs,1);assert.equal(f.calls.filter(c=>c==='collect').length,1);
});
test('incomplete capture cannot be omitted by starting a new run or merging',async t=>{
 const f=await fixture(t);f.setFailure(true);await assert.rejects(f.manager.collect(...f.args,1));
 await unlink(join(f.directory,'runs/01/capture/manifest.json'));
 await assert.rejects(f.manager.recover(...f.args));await assert.rejects(f.manager.collect(...f.args,2),/collection_recovery_required/);
 await assert.rejects(f.manager.merge(...f.args),/collection_incomplete/);assert.equal(f.calls.filter(c=>c==='collect').length,1);
});
test('recover never deletes an existing lock, even if its parent is dead; the collector child may still run',async t=>{
 const f=await fixture(t);const path=join(f.directory,'lock.json');
 await writeFile(path,JSON.stringify({pid:123,host:'different-host',token:'synthetic'}));
 await assert.rejects(f.manager.recover(...f.args),/collection_busy/);
 await writeFile(path,JSON.stringify({pid:123,host:hostname(),token:'synthetic'}));
 await assert.rejects(f.manager.recover(...f.args),/collection_busy/);
 await unlink(path); // Operator has separately checked both processes; production code never reclaims it.
 assert.equal((await f.manager.recover(...f.args)).runs,0);
});
test('missing sequence entries, changed config hashes and edited captures are rejected before network',async t=>{
 const f=await fixture(t);await assert.rejects(f.manager.collect(...f.args,2),/collection_recovery_required/);
 await f.manager.collect(...f.args,1);await writeFile(join(f.directory,'runs/01/capture/manifest.json'),'{}');
 await assert.rejects(f.manager.collect(...f.args,1),/sha_mismatch/);assert.equal(f.calls.filter(c=>c==='collect').length,1);
 await writeFile(join(f.directory,'discovery-config.json'),'{}');await assert.rejects(f.manager.status(...f.args),/sha_mismatch/);
});
test('the ten-run budget cannot be silently increased and replay failures cannot produce a union',async t=>{
 const f=await fixture(t);await assert.rejects(f.manager.collect(...f.args,11),/collection_input/);
 await f.manager.collect(...f.args,1);f.setCorrupt(true);await assert.rejects(f.manager.merge(...f.args),/synthetic_replay_failure/);
 assert.equal(f.calls.filter(c=>c==='merge').length,0);
});
test('deleting even the final run folder cannot erase its attempt from the collection',async t=>{
 const f=await fixture(t);await f.manager.collect(...f.args,1);
 const target=join(f.directory,'runs/01');assert(target.startsWith(f.directory+sep));await rm(target,{recursive:true});
 await assert.rejects(f.manager.collect(...f.args,1),/collection_run_inventory/);
 await assert.rejects(f.manager.merge(...f.args),/collection_run_inventory/);assert.equal(f.calls.filter(c=>c==='collect').length,1);
});
test('initialization is exclusive and cannot add a collection inside the frozen evaluator',async t=>{
 const f=await fixture(t),old=await readFile(join(f.directory,'collection.json'));
 const digest=sha(await readFile(join(f.bundle,'frozen/config.json')));
 await assert.rejects(f.manager.init(f.bundle,digest,'c'.repeat(64),f.directory),{code:'EEXIST'});
 await assert.rejects(f.manager.init(f.bundle,digest,'c'.repeat(64),join(f.bundle,'collection')),/collection_inside_bundle/);
 assert.deepEqual(await readFile(join(f.directory,'collection.json')),old);
});
