#!/usr/bin/env node
/** Offline build/verify, independently replaying membership before features. */
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildSeriesDevelopmentDataset} from './series-development-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
const forbidden=/(^|\/)(private-owner|node_modules|corepack|\.git|pgdata)(\/|$)|(?:access|credential|password|cookie|session|secret)\.[^/]+$/i;
function local(p){assert(typeof p==='string','path');const f=resolve(root,p),r=relative(root,f).replaceAll('\\','/');
  assert(!isAbsolute(r)&&!r.startsWith('../')&&!forbidden.test(r)&&(r.startsWith('.tools/')||r.startsWith('docs/evidence/'))&&r.endsWith('.json'),'path_scope');return f;}
async function contained(p){const r=relative(root,await realpath(p)).replaceAll('\\','/');assert(!isAbsolute(r)&&!r.startsWith('../')&&!forbidden.test(r),'real_path_scope');}
async function read(p,expected){const f=local(p);await contained(f);assert((await stat(f)).size<=128*1024**2,'file_limit');
  const b=await readFile(f);assert(/^[a-f0-9]{64}$/.test(expected)&&sha(b)===expected,'input_sha');return b;}
const parse=b=>JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));
async function compute(config){
  assert.equal(config.format,'series-development-input-v1');
  const member=parse(await read(config.membership.path,config.membership.sha256));
  assert.equal(member.format,'series-membership-file-v1');
  const check=spawnSync(process.execPath,['tools/research/series-membership.mjs','verify',config.membership.path,config.membership.sha256],
    {cwd:root,encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(check.status,0,'membership_replay_failed');
  const corpus=parse(await read(member.input.corpus.path,member.input.corpus.sha256));
  const inventory=parse(await read(config.inventory.path,config.inventory.sha256));
  // Repository exporter manifests contain executable inputs, never owner credential files.
  for(const item of inventory.source.code){
    assert(/^(packages\/(contracts|db)\/(dist\/[^/]+\.js|migrations\/[^/]+\.sql)|package\.json|pnpm-lock\.yaml|tools\/research\/series-development-export\.mjs)$/.test(item.path),'inventory_code_path');
    assert.equal(sha(await readFile(resolve(root,item.path))),item.sha256,'inventory_code_changed');
  }
  const result=buildSeriesDevelopmentDataset(inventory,member.result,corpus);
  const paths=['tools/research/series-development.mjs','tools/research/series-development-core.mjs','packages/prediction/dist/v1-features.js',
    'packages/db/dist/v1-features.js','packages/db/dist/v1-data.js','packages/db/dist/v1-release-inventory.js'];
  const code=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(resolve(root,p)))])));
  return {format:'series-development-file-v1',input:config,code,result,providerHttp:0,businessWrites:0,scoringPerformed:false};
}
try{
  const [mode,path,hash,output,...extra]=process.argv.slice(2);assert(!extra.length,'usage');
  if(mode==='build'){
    assert(output,'output_scope');const target=local(output);assert(relative(root,target).replaceAll('\\','/').startsWith('.tools/'),'output_scope');await contained(dirname(target));
    const value=await compute(parse(await read(path,hash))),bytes=JSON.stringify(value,null,2)+'\n';
    assert(Buffer.byteLength(bytes)<=128*1024**2,'output_limit');await writeFile(target,bytes,{flag:'wx'});
    console.log(JSON.stringify({sha256:sha(bytes),...value.result.summary}));
  }else{
    assert(mode==='verify'&&!output,'usage');const saved=parse(await read(path,hash));assert.equal(saved.format,'series-development-file-v1');
    assert.deepEqual(await compute(saved.input),saved,'development_replay');console.log(JSON.stringify({verified:true,...saved.result.summary}));
  }
}catch(e){console.error(e?.code==='EEXIST'?'Output exists; choose a new path.':'Series development failed: '+(e?.code??'invalid_input_or_replay'));process.exitCode=1;}
