/** Offline feature persistence; never trains, scores targets, or writes to the registry. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const runtimeDirectory='.tools/s304-prospective-features-runtime';
const sha=b=>createHash('sha256').update(b).digest('hex');
const compilerArgs=['node_modules/typescript/bin/tsc','tools/research/player-hero-prospective-features.mts',
  'tools/research/player-hero-inference.mts','--strict','--noUncheckedIndexedAccess','--skipLibCheck',
  '--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--types','node',
  '--typeRoots','packages/db/node_modules/@types','--outDir',runtimeDirectory];
async function bytes(path){const p=resolve(root,path);assert((await stat(p)).size<=128*1024*1024,'oversize_input');return readFile(p);}
function local(path,base=root){const p=resolve(root,path),rel=relative(base,p);
  assert(rel&&!rel.startsWith('..')&&!rel.includes(':'),'path_outside_workspace');return p;}
async function environment(){
  const captureBytes=await bytes('.tools/s304-prospective-demo-capture-r1.json');
  assert.equal(sha(captureBytes),'fd26110d7bb87ef856ca6635c14f35f4f96836e8700fa6fc7f00ecbf8058a6db');
  const frozen=JSON.parse(captureBytes);
  for(const [path,expected] of Object.entries(frozen.environment.code))assert.equal(sha(await bytes(path)),expected,'frozen_capture_changed');
  for(const [name,expected] of Object.entries(frozen.environment.runtime))
    assert.equal(sha(await bytes(join(runtimeDirectory,name))),expected,'frozen_runtime_changed');
  const fitBytes=await bytes('.tools/s304-hero-fit-r1/manifest.json');
  assert.equal(sha(fitBytes),'f5ad3fa4ac06ae66ef75f5db5af91fdbc651bc722433af360b310db5e99ffd52');
  const fit=JSON.parse(fitBytes);
  for(const path of ['tools/research/player-hero-inference.mts'])
    assert.equal(sha(await bytes(path)),fit.code.find(c=>c.path===path).sha256);
  assert.equal(sha(await bytes(join(runtimeDirectory,'player-hero-inference.mjs'))),
    fit.code.find(c=>c.path.endsWith('/compiled/player-hero-inference.mjs')).sha256);
  const artifactSha256=sha(await bytes('.tools/s304-hero-fit-r1/artifact.json'));
  assert.equal(artifactSha256,'9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b');
  assert.equal(sha(await bytes('packages/prediction/dist/v1-features.js')),'72d353e52f1ac3ccb553006173e90caf5b0e3015c5557e191a6ab5924ade4cd3');
  assert.equal(sha(await bytes('packages/contracts/dist/v1-features.js')),'77d1fe4bd55db8db0c419ba1dfad7805bc6aa541b7b15a2e42aa28e661e1b275');
  const paths=[...Object.keys(frozen.environment.code),'tools/research/player-hero-prospective-features.mts',
    'tools/research/player-hero-prospective-features.mjs','tools/research/player-hero-inference.mts',
    'tests/fixtures/player-hero-prospective-features.mjs','tests/node/player-hero-prospective-features.test.mjs',
    'tests/node/player-hero-prospective-features-cli.test.mjs','tests/research/player_hero_prospective_oracle.py',
    'tests/fixtures/player-hero-prospective-parity.mjs'];
  for(const directory of ['packages/contracts/dist','packages/prediction/dist',runtimeDirectory])
    for(const name of (await readdir(join(root,directory))).sort())if(/\.(js|mjs)$/.test(name))paths.push(directory+'/'+name);
  const code={};for(const path of [...new Set(paths)].sort())code[path]=sha(await bytes(path));
  return {node:process.version,compilerArgs,code,frozenFitArtifactSha256:artifactSha256};
}
async function main(){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='compile'){
    assert.equal(args.length,0);
    const result=spawnSync(process.execPath,compilerArgs,{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
    assert.equal(result.status,0,'strict_compile_failed');await environment();
    console.log('Strict prospective feature compilation and frozen-code checks PASS');return;
  }
  assert(['prepare','verify'].includes(mode));assert.equal(args.length,mode==='prepare'?2:3);
  const [inputPath,outputPath,expectedSha256]=args;
  const inputFile=local(inputPath),outputFile=local(outputPath,join(root,'.tools'));
  let saved=null;
  if(mode==='verify'){
    assert(/^[a-f0-9]{64}$/.test(expectedSha256??''));
    const data=await bytes(outputFile);assert.equal(sha(data),expectedSha256,'external_sha_mismatch');saved=JSON.parse(data);
  }
  const env=await environment();if(saved)assert.deepEqual(saved.environment,env,'environment_changed');
  const inputBytes=await bytes(inputFile),inputFileSha256=sha(inputBytes);
  if(saved)assert.equal(saved.inputFileSha256,inputFileSha256,'input_bytes_changed');
  const runtime=await import(pathToFileURL(join(root,runtimeDirectory,'player-hero-prospective-features.mjs')).href);
  const result=runtime.buildProspectivePlayerHeroFeatures(JSON.parse(inputBytes));
  const body={format:'player-hero-offline-feature-artifact-v1',environment:env,inputFileSha256,result,
    persistenceBasis:'offline_preparation_not_authenticated_prestart_persistence',
    syntheticOnly:result.syntheticOnly,primaryEligible:false,deployable:false};
  if(saved)assert.deepEqual(saved,body,'feature_replay_mismatch');
  else await writeFile(outputFile,JSON.stringify(body,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:mode==='verify'?'verified_offline_features':'saved_offline_features',
    artifactSha256:sha(await bytes(outputFile)),featureStatus:result.status,syntheticOnly:result.syntheticOnly,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
  console.error(e.code==='EEXIST'?'Расчёт уже сохранён; перезапись запрещена.'
    :'Расчёт отклонён: проверьте снимок, историю, время, SHA, среду и путь файла.');process.exitCode=1;
});
