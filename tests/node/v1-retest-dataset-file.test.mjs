import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveRetestDataset} from '../../scripts/lib/v1-retest-dataset-file.mjs';
import {bounded,sha} from '../../scripts/lib/evaluation-discovery-files.mjs';

test('retest export larger than the discovery cap survives the SHA-bound dataset reader',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retest-large-json-'));
 try{
  const path=join(dir,'synthetic.json'),value={syntheticOnly:true,evidence:'x'.repeat(33*1024*1024)};
  const result=await saveRetestDataset(path,value);
  assert(result.bytes>33554432);assert(result.bytes<=134217728);
  assert.equal((await stat(path)).size,result.bytes);
  const replay=await bounded(path,134217728,result.sha256);
  assert.deepEqual(replay.data,value);assert.equal(sha(replay.bytes),result.sha256);
  await assert.rejects(bounded(path,134217728,'0'.repeat(64)),/discovery_file_sha_mismatch/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('retest dataset output is exclusive and preserves an existing artifact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retest-exclusive-json-'));
 try{
  const path=join(dir,'existing.json');await writeFile(path,'original\n');
  await assert.rejects(saveRetestDataset(path,{syntheticOnly:true}),{code:'EEXIST'});
  assert.equal(await readFile(path,'utf8'),'original\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('retest dataset limit counts UTF-8 bytes and refuses oversized output before creating it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retest-bounded-json-'));
 try{
  const path=join(dir,'too-large.json');
  await assert.rejects(saveRetestDataset(path,{syntheticOnly:true,evidence:'я'.repeat(64*1024*1024)}),/retest_import_dataset_file_limit/);
  await assert.rejects(stat(path),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
