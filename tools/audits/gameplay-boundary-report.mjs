/** Exclusive report/replay over captured evidence; no HTTP or DB access. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {summarizeGameplayClocks} from './gameplay-boundary-core.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),dir='.tools/s304-gameplay-boundary-r1';
async function build(){
 const sources={};async function read(path){const b=await readFile(path);assert(b.length<=8*1024*1024,'source_size');sources[path]=sha(b);return b;}
 const plan=JSON.parse(await read(dir+'/plan.json')),receipt=JSON.parse(await read(dir+'/receipts.json'));
 assert.equal(sha(await read(dir+'/plan.json')),receipt.planSha256);assert.equal(sha(await read('tools/audits/gameplay-boundary-collect.mjs')),receipt.codeSha256);
 const opendota=[];let stratz=null;
 for(const r of receipt.requests)if(r.file){assert(/^(opendota-\d+|stratz)\.json$/.test(r.file),'unsafe_receipt_path');
   const b=await read(dir+'/'+r.file);assert.equal(sha(b),r.sha256,'receipt_sha_mismatch');
   if(r.result==='captured'){if(r.provider==='opendota')opendota.push(JSON.parse(b));else if(r.provider==='stratz')stratz=JSON.parse(b);else throw Error('provider');}}
 const local=JSON.parse(await read('.tools/s304-clock-local-receipts-r1.json'));
 const publicSources=[];
 for(const list of ['receipts.json','core-receipts.json']){
   const receipts=JSON.parse(await read('.tools/s304-clock-sources-r1/'+list));
   for(const r of receipts){assert(/^[A-Za-z0-9.-]+$/.test(r.file),'unsafe_public_path');
     assert.equal(sha(await read('.tools/s304-clock-sources-r1/'+r.file)),r.sha256,'public_sha_mismatch');publicSources.push(r);}}
 const result=summarizeGameplayClocks({ids:plan.matchIds,opendota,stratz,local:local.rows});
 const code={};for(const f of ['gameplay-boundary-core.mjs','gameplay-boundary-report.mjs'])code[f]=sha(await read('tools/audits/'+f));
 return {format:'gameplay-boundary-report-v1',node:process.version,code,sources,publicSources,providerAttempts:receipt.opendotaStats.attempts+
   receipt.requests.filter(r=>r.provider==='stratz').reduce((n,r)=>n+(r.attempts??0),0),result};
}
const [mode,expected,...extra]=process.argv.slice(2);assert(!extra.length);
try{
 const report=await build(),file=dir+'/analysis.json';
 if(mode==='capture'){assert.equal(expected,undefined);const text=JSON.stringify(report,null,2)+'\n';await writeFile(file,text,{flag:'wx'});
  console.log(JSON.stringify({status:'saved',sha256:sha(text),...report.result.counts,providerAttempts:report.providerAttempts}));}
 else{assert.equal(mode,'verify');assert(/^[a-f0-9]{64}$/.test(expected??''));const b=await readFile(file);assert.equal(sha(b),expected,'external_sha_mismatch');
  assert.deepEqual(JSON.parse(b),report,'replay_mismatch');console.log(JSON.stringify({status:'verified',...report.result.counts}));}
}catch{console.error('Аудит отклонён: проверьте исходные файлы, SHA, версию кода и режим. Перезапись запрещена.');process.exitCode=1;}
