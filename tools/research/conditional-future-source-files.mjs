import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,realpath} from 'node:fs/promises';
import {resolve,relative,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
const policy='tools/research/player-hero-conditional-future-policy.json',policySha='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f';
const runtime='.tools/s304-future-runtime';
const codePaths=[policy,'tools/research/conditional-future-source-binding.mjs','tools/research/conditional-future-source-files.mjs',
 'tools/research/conditional-future-holdout.mts','tools/research/player-hero-feature.mts',
 'packages/ingestion/dist/quality.js','packages/ingestion/dist/opendota/schemas.js','packages/db/dist/identity.js',
 'packages/contracts/dist/identity.js','packages/contracts/dist/v1-features.js','packages/prediction/dist/v1-features.js','pnpm-lock.yaml',
 runtime+'/conditional-future-holdout.mjs',runtime+'/player-hero-feature.mjs'];
async function privatePath(path,existing=true){
 const full=resolve(root,path),base=await realpath(join(root,'.tools'));
 const checked=existing?await realpath(full):join(await realpath(dirname(full)),full.slice(dirname(full).length+1));
 const rel=relative(base,checked);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'),'private_path_required');return full;
}
async function bytes(path){const s=await stat(path);assert(s.isFile()&&s.size<=32*1024*1024,'bounded_file_required');return readFile(path);}
async function main(){
 const [mode,...args]=process.argv.slice(2);assert(mode==='build'?args.length===5:mode==='verify'&&args.length===2,'arguments');
 const compiled=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','tools/research/conditional-future-holdout.mts','--strict','--noUncheckedIndexedAccess',
  '--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--typeRoots','packages/db/node_modules/@types','--outDir',runtime],
  {cwd:root,encoding:'utf8',maxBuffer:1024*1024});assert.equal(compiled.status,0,'compile_failed');
 const {bindConditionalFutureSources,sourceSha}=await import('./conditional-future-source-binding.mjs');
 assert.equal(sourceSha(await readFile(join(root,policy))),policySha,'policy_changed');
 let directory,sourceRefs,savedManifest;
 if(mode==='build'){
  const [inputPath,inputSha256,archivePath,archiveSha256,outputPath]=args;
  assert(/^[a-f0-9]{64}$/.test(inputSha256)&&/^[a-f0-9]{64}$/.test(archiveSha256),'expected_hash_required');
  directory=await privatePath(outputPath,false);sourceRefs={input:{path:relative(root,await privatePath(inputPath)),sha256:inputSha256},archive:{path:relative(root,await privatePath(archivePath)),sha256:archiveSha256}};
 }else{
  directory=await privatePath(args[0]);const manifestBytes=await bytes(join(directory,'manifest.json'));
  assert.equal(sourceSha(manifestBytes),args[1],'external_manifest_hash_mismatch');savedManifest=JSON.parse(manifestBytes);sourceRefs=savedManifest.sources;
 }
 const loaded={};for(const [name,r] of Object.entries(sourceRefs)){
  const b=await bytes(await privatePath(r.path));assert.equal(sourceSha(b),r.sha256,'pinned_source_changed');loaded[name]=JSON.parse(b);
 }
 if(!loaded.archive.syntheticOnly)assert(loaded.archive.recordedAt<=new Date().toISOString(),'future_source_snapshot');
 const result=bindConditionalFutureSources(loaded.input,loaded.archive);
 const outputs={'features.json':result.features,'labels.json':result.labels,'sources.json':result.sourceLedger};
 const serialized=Object.fromEntries(Object.entries(outputs).map(([file,body])=>[file,JSON.stringify(body,null,2)+'\n']));
 const manifest={format:'conditional-source-files-v1',node:process.version,policySha256:policySha,sources:sourceRefs,
  code:Object.fromEntries(await Promise.all(codePaths.map(async p=>[p,sourceSha(await readFile(join(root,p)))]))),
  artifacts:Object.fromEntries(Object.entries(serialized).map(([file,text])=>[file,sourceSha(text)])),
  syntheticOnly:loaded.archive.syntheticOnly,registrationAllowed:false,collectionAllowed:false,deployable:false};
 const manifestText=JSON.stringify(manifest,null,2)+'\n';
 if(mode==='build'){
  await mkdir(directory);for(const [file,text] of Object.entries(serialized))await writeFile(join(directory,file),text,{flag:'wx'});
  await writeFile(join(directory,'manifest.json'),manifestText,{flag:'wx'});
 }else{
  assert.deepEqual(savedManifest,manifest,'manifest_replay_mismatch');
  for(const [file,text] of Object.entries(serialized))assert.equal((await bytes(join(directory,file))).toString('utf8'),text,'output_replay_mismatch');
 }
 console.log(JSON.stringify({status:mode==='build'?'source_bound_files_saved':'source_bound_files_verified',manifestSha256:sourceSha(manifestText),
  syntheticOnly:manifest.syntheticOnly,sourceBoundMaps:result.sourceLedger.rows.filter(r=>r.status==='source_bound').length,
  labels:result.labels.rows.length,independentTest:false,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 console.error(error.code==='EEXIST'?'Каталог уже существует; используйте verify или новый путь.':
  'Проверка источников отклонена: проверьте закреплённые SHA, файлы, контракт и путь внутри .tools.');process.exitCode=1;
});
