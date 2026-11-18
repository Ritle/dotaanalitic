// Synthetic artifacts in a private test directory; never used by the real source plan.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureLedger,verifyLedger} from '../../tools/research/exposure-ledger.mjs';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function setup(){
 const directory=await mkdtemp(resolve(root,'.tools/exposure-ledger-test-'));
 const path=name=>relative(root,resolve(directory,name)).replaceAll('\\','/');
 const source={format:'exposure-database-snapshot-v1',readOnly:true,maps:[{matchId:'9007199254740993',localSeriesId:null,provider:null,providerSeriesId:null}]};
 const bytes=JSON.stringify(source);
 await writeFile(resolve(root,path('source.json')),bytes);
 const plan={format:'exposure-source-plan-v1',capturedAt:'2026-11-14T00:00:00.000Z',
 sources:[{path:path('source.json'),sha256:sha(bytes),adapter:'database'}],pendingReview:['synthetic_test_only'],registrationAllowed:false};
 await writeFile(resolve(root,path('plan.json')),JSON.stringify(plan));
 return {path,plan};
}
test('exclusive capture, source-bound replay and external digest',async()=>{
 const {path}=await setup(),result=await captureLedger(path('plan.json'),path('report.json'));
 assert.equal((await verifyLedger(path('report.json'),result.sha256)).verified,true);
 await assert.rejects(captureLedger(path('plan.json'),path('report.json')),e=>e.code==='EEXIST');
 await assert.rejects(verifyLedger(path('report.json'),'b'.repeat(64)),/source_sha_changed/);
 assert.equal((await verifyLedger(path('report.json'),result.sha256)).verified,true);
});
test('changed source rejected even if report remains intact',async()=>{
 const {path}=await setup(),result=await captureLedger(path('plan.json'),path('report.json'));
 await writeFile(resolve(root,path('source.json')),'{}');
 await assert.rejects(verifyLedger(path('report.json'),result.sha256),/source_sha_changed/);
});
test('rehashed report cannot invent a map or remove a blocker',async()=>{
 const {path}=await setup();await captureLedger(path('plan.json'),path('report.json'));
 const data=JSON.parse(await readFile(resolve(root,path('report.json')),'utf8'));
 data.result.mapIds.push('123');data.result.completeGlobalInventory=true;
 const bytes=JSON.stringify(data);await writeFile(resolve(root,path('tampered.json')),bytes);
 await assert.rejects(verifyLedger(path('tampered.json'),sha(bytes)),/ledger_replay_mismatch/);
});
test('outside-repository and secret source paths are rejected before reading',async()=>{
 const {path,plan}=await setup();
 await assert.rejects(captureLedger(path('plan.json'),'../escape.json'),/repository_json_required/);
 plan.sources[0].path='.tools/private-owner/access.json';
 await writeFile(resolve(root,path('forbidden-plan.json')),JSON.stringify(plan));
 await assert.rejects(captureLedger(path('forbidden-plan.json'),path('unused.json')),/private_or_dependency_path/);
});
