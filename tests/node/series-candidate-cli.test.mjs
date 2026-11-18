import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';

test('series CLI stays offline and refuses overwrite, bad input and publication claims',async()=>{
 const root=resolve('.tools'),dir=await mkdtemp(resolve(root,'series-cli-'));
 assert(dir.startsWith(root+sep));
 const input=resolve(dir,'synthetic-input.json'),output=resolve(dir,'report.json');
 const run=()=>spawnSync(process.execPath,['tools/research/evaluate-series-candidate.mjs',input,output],{
  encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://invalid.invalid:1/not-used'}});
 try{
  await writeFile(input,'[]');const first=run();assert.equal(first.status,0,first.stderr);
  const bytes=await readFile(output,'utf8'),result=JSON.parse(bytes);
  assert.equal(result.purpose,'development_only');assert.equal(result.deployable,false);assert.equal(result.seriesCandidate.n,0);assert.equal(result.seriesCandidate.brier,null);
  assert.equal(run().status,1);assert.equal(await readFile(output,'utf8'),bytes);
  await rm(output);await writeFile(input,JSON.stringify([{privateToken:'synthetic-never-print-this'}]));const invalid=run();assert.equal(invalid.status,1);assert(!invalid.stderr.includes('synthetic-never-print-this'));
  await assert.rejects(readFile(output),{code:'ENOENT'});
 }finally{assert(dir.startsWith(root+sep));await rm(dir,{recursive:true,force:true});}
});
