// Synthetic local fixtures only; not referenced by any real source plan.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
import {captureArchiveReview,verifyArchiveReview} from '../../tools/research/exposure-archive-review.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function setup(){
 const dir=await mkdtemp(resolve(root,'.tools/archive-test-'));
 const path=n=>relative(root,resolve(dir,n)).replaceAll('\\','/');
 const put=async(n,x)=>{const b=JSON.stringify(x);await writeFile(resolve(root,path(n)),b);return {path:path(n),sha256:sha(b)};};
 const baseline=await put('baseline.json',{result:{mapIds:['10'],canonicalSeriesKeys:[],aliases:[]}});
 const priorSurvey=await put('survey.json',{syntheticOnly:true});
 const source=await put('source.json',{matchId:'10'});
 const code={};for(const p of ['tools/research/exposure-archive-core.mjs','tools/research/exposure-archive-review.mjs','tools/research/exposure-archive-sources.mjs','tools/research/exposure-ledger-core.mjs'])
   code[p]=sha(await readFile(resolve(root,p)));
 await put('plan.json',{format:'exposure-archive-plan-v1',createdAt:'2026-11-14T00:00:00.000Z',baseline,priorSurvey,code,
  sources:[{...source,origin:'synthetic_test_only',changedSincePriorSurvey:null}],excluded:[]});
 return {path,put};
}
test('source-bound archive replay, overwrite rejection and mandatory external SHA',async()=>{
 const {path}=await setup(),r=await captureArchiveReview(path('plan.json'),path('report.json'));
 assert.equal((await verifyArchiveReview(path('report.json'),r.sha256)).verified,true);
 await assert.rejects(captureArchiveReview(path('plan.json'),path('report.json')),e=>e.code==='EEXIST');
 await assert.rejects(verifyArchiveReview(path('report.json')),/external_sha_required/);
 await assert.rejects(verifyArchiveReview(path('report.json'),'b'.repeat(64)),/source_changed/);
});
test('source mutation cannot pass even with an unchanged saved report',async()=>{
 const {path,put}=await setup(),r=await captureArchiveReview(path('plan.json'),path('report.json'));
 await put('source.json',{matchId:'11'});
 await assert.rejects(verifyArchiveReview(path('report.json'),r.sha256),/source_changed/);
});
test('rehashed summary or eligibility substitution is rejected',async()=>{
 const {path,put}=await setup();await captureArchiveReview(path('plan.json'),path('report.json'));
 const r=JSON.parse(await readFile(resolve(root,path('report.json')),'utf8'));
 r.result.completeGlobalInventory=true;r.result.summary.files=0;
 const changed=await put('modified.json',r);
 await assert.rejects(verifyArchiveReview(changed.path,changed.sha256),/replay_mismatch/);
});
test('outside and sensitive paths are rejected before reading archive contents',async()=>{
 const {path}=await setup();
 await assert.rejects(captureArchiveReview(path('plan.json'),'../outside.json'),/local_json_required/);
 await assert.rejects(captureArchiveReview('.tools/private-owner/access.json',path('report.json')),/sensitive_or_dependency_path/);
});
test('nested native raw sources expand exclusions and resolve a formerly unknown reference',async()=>{
 const {path,put}=await setup(),body=JSON.stringify([{match_id:11,series_id:3}]);
 const source=await put('source.json',{discoveries:[{rawBody:body,source:{provider:'opendota',endpoint:'/teams/1/matches',payloadSha256:sha(body)}}]});
 const p=JSON.parse(await readFile(resolve(root,path('plan.json')),'utf8'));p.sources[0]={...p.sources[0],...source};await put('plan.json',p);
 const saved=await captureArchiveReview(path('plan.json'),path('report.json'));
 const r=JSON.parse(await readFile(resolve(root,path('report.json')),'utf8')).result;
 assert.deepEqual(r.extendedLedger.mapIds,['10','11']);assert.deepEqual(r.extendedLedger.canonicalSeriesKeys,['["opendota","3"]']);
 assert.deepEqual(r.summary.novelMapIds,[]);assert.equal(r.completeGlobalInventory,false);
 assert.equal((await verifyArchiveReview(path('report.json'),saved.sha256)).verified,true);
});
test('legacy receipt joins only through its exact manifest digest',async()=>{
 const {path,put}=await setup(),body=JSON.stringify([{match_id:11,series_id:3}]);
 const receipt=await put('receipt-000.json',{status:'captured',endpoint:'/leagues/1/matches',rawBody:body,payloadSha256:sha(body)});
 const manifest=await put('manifest.json',{format:'evaluation-discovery-run-v1',receipts:[{path:'receipt-000.json',sha256:receipt.sha256}]});
 const p=JSON.parse(await readFile(resolve(root,path('plan.json')),'utf8'));
 p.sources.push({...receipt,origin:'synthetic_test_only',changedSincePriorSurvey:null},{...manifest,origin:'synthetic_test_only',changedSincePriorSurvey:null});
 await put('plan.json',p);await captureArchiveReview(path('plan.json'),path('bound.json'));
 const bound=JSON.parse(await readFile(resolve(root,path('bound.json')),'utf8')).result;
 assert.deepEqual(bound.extendedLedger.mapIds,['10','11']);assert.equal(bound.archiveSources[0].manifestBinding.sha256,manifest.sha256);
 const wrong=await put('manifest.json',{format:'evaluation-discovery-run-v1',receipts:[{path:'receipt-000.json',sha256:'b'.repeat(64)}]});
 p.sources[2]={...p.sources[2],...wrong};await put('other-plan.json',p);
 await captureArchiveReview(path('other-plan.json'),path('unbound.json'));
 const unbound=JSON.parse(await readFile(resolve(root,path('unbound.json')),'utf8')).result;
 assert.deepEqual(unbound.extendedLedger.mapIds,['10']);assert.deepEqual(unbound.summary.novelMapIds,['11']);
});
