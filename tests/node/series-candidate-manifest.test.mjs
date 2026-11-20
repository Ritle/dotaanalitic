import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=new URL('../../',import.meta.url);
const cli=fileURLToPath(new URL('tools/research/series-candidate-manifest.mjs',root));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(args,flags=[])=>spawnSync(process.execPath,[...flags,cli,...args],{encoding:'utf8',timeout:15000});

async function manifestFixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'bo3-manifest-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'manifest.json');
  const result=run(['create',path]);
  assert.equal(result.status,0,result.stderr);
  return {path,summary:JSON.parse(result.stdout),bytes:await readFile(path)};
}

test('CLI fingerprints the real candidate, workspace contracts, installed Zod and Node binary',async t=>{
  const {path,summary,bytes}=await manifestFixture(t);
  assert.equal(summary.sha256,sha(bytes));
  assert.equal(summary.status,'created');
  const manifest=JSON.parse(bytes);
  assert.equal(manifest.bestOf,3);
  assert.deepEqual(manifest.candidate.elo,{initialRating:1500,k:32,scale:400});
  assert.equal(manifest.runtime.node,process.version);
  assert.equal(manifest.runtime.nodeBinarySha256,sha(await readFile(process.execPath)));
  const code=new Map(manifest.files.map(file=>[file.path,file.sha256]));
  for(const relative of ['packages/prediction/dist/v1-features.js','packages/prediction/dist/v1-candidate.js',
    'packages/prediction/dist/series/candidate.js','packages/contracts/dist/series/forecast.js',
    'packages/contracts/dist/identity.js','pnpm-lock.yaml']) {
    assert.equal(code.get(relative),sha(await readFile(new URL(relative,root))));
  }
  assert(code.has('dependency/zod/package.json'));
  const verified=run(['verify',path,summary.sha256]);
  assert.equal(verified.status,0,verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout),{...summary,status:'verified'});
  const duplicate=run(['create',path]);
  assert.notEqual(duplicate.status,0);
  assert.match(duplicate.stderr,/EEXIST/);
  assert.deepEqual(await readFile(path),bytes);
});

test('verification rejects a different Node configuration or an edited manifest',async t=>{
  const {path,summary,bytes}=await manifestFixture(t);
  const otherRuntime=run(['verify',path,summary.sha256],['--no-warnings']);
  assert.notEqual(otherRuntime.status,0);
  assert.match(otherRuntime.stderr,/candidate executable or runtime changed/);
  const edited=JSON.parse(bytes);
  edited.files.find(file=>file.path==='packages/contracts/dist/identity.js').sha256='0'.repeat(64);
  const changed=JSON.stringify(edited,null,2)+'\n';
  await writeFile(path,changed);
  const wrongDigest=run(['verify',path,summary.sha256]);
  assert.notEqual(wrongDigest.status,0);
  assert.match(wrongDigest.stderr,/stored candidate manifest digest mismatch/);
  const wrongCode=run(['verify',path,sha(changed)]);
  assert.notEqual(wrongCode.status,0);
  assert.match(wrongCode.stderr,/candidate executable or runtime changed/);
});
