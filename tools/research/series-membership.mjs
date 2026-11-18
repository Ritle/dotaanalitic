#!/usr/bin/env node
/** Explicit offline build/verify: no DB, HTTP, inference, activation or alias writes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {valveMembershipSource,auditSeriesMembership} from './series-membership-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
const forbidden=/(^|\/)(private-owner|node_modules|corepack|\.git|pgdata)(\/|$)|(?:access|credential|password|cookie|session|secret)\.[^/]+$/i;
function local(p){assert(typeof p==='string','path');const f=resolve(root,p),r=relative(root,f).replaceAll('\\','/');
  assert(!isAbsolute(r)&&!r.startsWith('../')&&!forbidden.test(r)&&(r.startsWith('.tools/')||r.startsWith('docs/evidence/'))&&/\.(json|proto)$/.test(r),'path_scope');return f;}
async function contained(p){const r=relative(root,await realpath(p)).replaceAll('\\','/');assert(!isAbsolute(r)&&!r.startsWith('../')&&!forbidden.test(r),'real_path_scope');}
async function read(p,expected){const f=local(p);await contained(f);assert((await stat(f)).size<=128*1024**2,'file_limit');
  const b=await readFile(f);assert(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected)&&sha(b)===expected,'input_sha');return b;}
const parse=b=>JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));
async function compute(config){
  assert.equal(config.format,'series-membership-input-v1');assert(Array.isArray(config.valveSources)&&config.valveSources.length<=20,'source_limit');
  const corpus=parse(await read(config.corpus.path,config.corpus.sha256));
  const exposure=parse(await read(config.exposure.path,config.exposure.sha256));assert.equal(corpus.exposure.sha256,config.exposure.sha256,'exposure_binding');
  const proto=(await read(config.proto.path,config.proto.sha256)).toString('utf8');
  const body=proto.match(/enum ELeagueNodeType\s*\{([^}]+)\}/)?.[1];assert(body,'node_enum');
  for(const [name,n] of [['ONE',1],['THREE',2],['FIVE',3],['TWO',4]])assert(new RegExp('BEST_OF_'+name+'\\s*=\\s*'+n+'\\s*;').test(body),'node_enum_value');
  const sources=[];for(const s of config.valveSources){
    const b=await read(s.path,s.sha256);assert.equal(s.receipt.file,s.path,'receipt_path');assert.equal(s.receipt.sha256,s.sha256,'receipt_sha');
    sources.push(valveMembershipSource(b,s.receipt,s.path));}
  const result=auditSeriesMembership(corpus,exposure.result.ledger,sources);
  const paths=['tools/research/series-membership.mjs','tools/research/series-membership-core.mjs','tools/research/series-corpus-core.mjs','tools/research/exposure-namespace-core.mjs','tools/research/exposure-ledger-core.mjs','packages/db/dist/temporal.js'];
  const code=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(resolve(root,p)))])));
  return {format:'series-membership-file-v1',input:config,code,result,providerHttp:0,businessWrites:0,scoringPerformed:false};
}
try{
  const [mode,path,hash,output,...extra]=process.argv.slice(2);assert(!extra.length,'usage');
  if(mode==='build'){
    assert(output,'output_scope');const target=local(output);assert(relative(root,target).replaceAll('\\','/').startsWith('.tools/'),'output_scope');await contained(dirname(target));
    const config=parse(await read(path,hash)),value=await compute(config);const bytes=JSON.stringify(value,null,2)+'\n';
    await writeFile(target,bytes,{flag:'wx'});console.log(JSON.stringify({sha256:sha(bytes),...value.result.summary}));
  }else{
    assert(mode==='verify'&&!output,'usage');const saved=parse(await read(path,hash));assert.equal(saved.format,'series-membership-file-v1');
    assert.deepEqual(await compute(saved.input),saved,'membership_replay');console.log(JSON.stringify({verified:true,...saved.result.summary}));
  }
}catch(e){console.error(e?.code==='EEXIST'?'Output exists; choose a new path.':'Series membership failed: '+(e?.code??'invalid_input_or_replay'));process.exitCode=1;}
