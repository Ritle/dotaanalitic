/** Offline file persistence only; never a real-time acquisition or prediction endpoint. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const runtimeDirectory='.tools/s304-prospective-capture-runtime';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const compilerArgs=['node_modules/typescript/bin/tsc','tools/research/player-hero-prospective-capture.mts',
  '--strict','--noUncheckedIndexedAccess','--skipLibCheck','--target','ES2022','--module','NodeNext',
  '--moduleResolution','NodeNext','--types','node','--typeRoots','packages/db/node_modules/@types','--outDir',runtimeDirectory];
const codePaths=['tools/research/player-hero-prospective-capture.mts','tools/research/player-hero-prospective-capture.mjs',
  'tools/research/player-hero-feature.mts','tests/node/player-hero-prospective-capture.test.mjs',
  'tests/node/player-hero-prospective-capture-cli.test.mjs',
  'tests/fixtures/player-hero-prospective-input.mjs','package.json','pnpm-lock.yaml',
  'node_modules/typescript/lib/typescript.js','node_modules/typescript/lib/_tsc.js',
  'packages/db/node_modules/@types/node/package.json','packages/db/node_modules/@types/node/index.d.ts',
  'packages/contracts/node_modules/zod/package.json'];

async function bytes(path){
  const full=resolve(root,path);assert((await stat(full)).size<=128*1024*1024,'oversize_input');
  return readFile(full);
}
async function json(path){const data=await bytes(path);return {value:JSON.parse(data.toString('utf8')),sha256:sha(data)};}
function local(path,base=root){
  const full=resolve(root,path),rel=relative(base,full);
  assert(rel&&!rel.startsWith('..')&&!rel.includes(':'),'path_outside_workspace');return full;
}
async function frozenBuilder(){
  const m=await json('.tools/s304-hero-contract-r1/manifest.json');
  const e=await json('docs/evidence/s3-04-player-hero-feature-contract.json');
  assert.equal(m.sha256,e.value.artifacts['manifest.json']);
  assert.equal(sha(await bytes('tools/research/player-hero-feature.mts')),m.value.code['tools/research/player-hero-feature.mts']);
  return m;
}
async function environment(){
  const old=await frozenBuilder(),code={},runtime={};
  for(const path of codePaths)code[path]=sha(await bytes(path));
  for(const file of ['player-hero-prospective-capture.mjs','player-hero-feature.mjs'])
    runtime[file]=sha(await bytes(join(runtimeDirectory,file)));
  assert.equal(runtime['player-hero-feature.mjs'],old.value.compiledSha256,'old_builder_runtime_changed');
  return {node:process.version,compilerArgs,code,runtime,frozenBuilderManifestSha256:old.sha256};
}
async function main(){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='compile'){
    assert.equal(args.length,0);await frozenBuilder();
    const result=spawnSync(process.execPath,compilerArgs,{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
    assert.equal(result.status,0,'strict_compile_failed');await environment();
    console.log('Strict prospective capture compilation PASS');return;
  }
  assert(['capture','verify'].includes(mode));assert.equal(args.length,mode==='capture'?2:3);
  const [inputPath,outputPath,expectedSha256]=args;
  assert(inputPath&&outputPath);const inputFile=local(inputPath),outputFile=local(outputPath,join(root,'.tools'));
  let saved=null;
  if(mode==='verify'){
    assert(/^[a-f0-9]{64}$/.test(expectedSha256??''),'expected_sha_required');
    const data=await bytes(outputFile);assert.equal(sha(data),expectedSha256,'capture_external_sha_mismatch');
    saved=JSON.parse(data.toString('utf8'));
  }
  const env=await environment();
  if(saved)assert.deepEqual(saved.environment,env,'capture_environment_changed');
  const input=await json(inputFile);
  if(saved)assert.equal(input.sha256,saved.inputFileSha256,'capture_input_bytes_changed');
  const runtime=await import(pathToFileURL(join(root,runtimeDirectory,'player-hero-prospective-capture.mjs')).href);
  const capture=runtime.createProspectiveCapture(input.value);
  const preparedAt=saved?.preparedAt??new Date().toISOString();
  assert(new Date(preparedAt).toISOString()===preparedAt&&preparedAt<=new Date().toISOString());
  const body={format:'player-hero-offline-capture-artifact-v1',preparedAt,environment:env,inputFileSha256:input.sha256,capture,
    persistenceBasis:'offline_artifact_preparation_not_proof_of_original_capture_time',
    syntheticOnly:capture.syntheticOnly,primaryEligible:false,registrationAllowed:false,collectionAllowed:false,
    predictionPerformed:false,deployable:false};
  const output={...body,fingerprint:runtime.captureDigest(body)};
  if(saved)assert.deepEqual(output,saved,'capture_replay_mismatch');
  else await writeFile(outputFile,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:mode==='verify'?'verified_offline_capture':'saved_offline_capture',
    artifactSha256:sha(await bytes(outputFile)),captureStatus:capture.status,syntheticOnly:capture.syntheticOnly,
    primaryEligible:false,predictionPerformed:false,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  console.error(error.code==='EEXIST'?'Снимок уже существует; перезапись запрещена.'
    :'Снимок отклонён: проверьте контракт, время, SHA, среду и путь файла.');process.exitCode=1;
});
