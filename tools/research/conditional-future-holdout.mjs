/** Local replay wrapper. Does not register, collect, verify provider evidence or publish scores. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const policyPath='tools/research/player-hero-conditional-future-policy.json';
const policySha='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f';
const runtimeDirectory='.tools/s304-future-runtime';
const args=['node_modules/typescript/bin/tsc','tools/research/conditional-future-holdout.mts','--strict','--noUncheckedIndexedAccess',
 '--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--typeRoots','packages/db/node_modules/@types','--outDir',runtimeDirectory];
const codePaths=[policyPath,'tools/research/conditional-future-holdout.mts','tools/research/conditional-future-holdout.mjs',
 'tools/research/player-hero-feature.mts','packages/prediction/dist/v1-features.js','packages/contracts/dist/v1-features.js',
 'packages/contracts/dist/identity.js','packages/contracts/dist/research-elo.js','packages/prediction/dist/index.js','packages/contracts/dist/index.js',
 'node_modules/typescript/lib/_tsc.js','pnpm-lock.yaml'];
const sha=b=>createHash('sha256').update(b).digest('hex');
function privatePath(path){const full=resolve(root,path),rel=relative(join(root,'.tools'),full);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'),'private_path_required');return full;}
async function json(path){const s=await stat(path);assert(s.isFile()&&s.size<=32*1024*1024,'input_too_large');return JSON.parse(await readFile(path,'utf8'));}
async function runtime(){
 assert.equal(sha(await readFile(join(root,policyPath))),policySha,'approved_policy_changed');
 const compiled=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:1024*1024});assert.equal(compiled.status,0,'strict_compile_failed');
 const hashes=Object.fromEntries(await Promise.all(codePaths.map(async p=>[p,sha(await readFile(join(root,p)))])));
 for(const file of ['conditional-future-holdout.mjs','player-hero-feature.mjs'])hashes[runtimeDirectory+'/'+file]=sha(await readFile(join(root,runtimeDirectory,file)));
 return {api:await import(pathToFileURL(join(root,runtimeDirectory,'conditional-future-holdout.mjs')).href),hashes};
}
async function main(){
 const [mode,first,second,...extra]=process.argv.slice(2);
 assert(!extra.length&&first&&((mode==='build'&&second)||(mode==='verify'&&!second)),'arguments');
 const destination=privatePath(mode==='build'?second:first);
 const saved=mode==='verify'?await json(destination):null;
 const input=mode==='build'?await json(privatePath(first)):saved.input;
 const {api,hashes}=await runtime();
 const result=api.buildConditionalFutureHoldout(input);
 const body={format:'conditional-future-holdout-artifact-v1',node:process.version,policySha256:policySha,code:hashes,
  input,inputSha256:api.conditionalDigest(input),result,registrationAllowed:false,collectionAllowed:false,deployable:false};
 const artifact={...body,fingerprint:api.conditionalDigest(body)};
 if(mode==='build')await writeFile(destination,JSON.stringify(artifact,null,2)+'\n',{flag:'wx'});
 else assert.equal(api.conditionalDigest(saved),api.conditionalDigest(artifact),'artifact_replay_mismatch');
 console.log(JSON.stringify({status:mode==='build'?'local_inputs_saved':'local_inputs_verified',syntheticOnly:result.syntheticOnly,
  denominator:result.denominator,pairedMaps:result.pairedMaps,fingerprint:artifact.fingerprint,independentTest:false,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 console.error(error.code==='EEXIST'?'Файл уже существует; используйте verify или новый путь.':
  'Подготовка отклонена: проверьте локальные входы, утверждённую политику, компиляцию и контрольные суммы.');process.exitCode=1;
});
