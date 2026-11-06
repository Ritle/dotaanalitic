import {mkdir,readFile,writeFile,realpath,lstat,open} from 'node:fs/promises';
import {resolve,dirname,sep,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {releaseExecutionCode,releaseRuntime} from './v1-release-files.mjs';
import {verifyRetestCapsule,verifyRetestFreeze,scoreRetestEvaluation,retestRegistryBinding} from './v1-retest-execution.mjs';
import {bounded,sha,save} from './v1-historical-protocol.mjs';

const fail=code=>{throw Error('retest_execution_'+code);};
export const executionRoot=fileURLToPath(new URL('../../',import.meta.url));
const encode=value=>JSON.stringify(value,null,2)+'\n';
async function local(root,path){
  const target=resolve(root,path),actual=await realpath(target);
  if(!target.startsWith(root+sep)||actual!==target||(await lstat(target)).isSymbolicLink())fail('bundle_path');return target;
}
export async function saveRetestBundle(directory,capsule,capsuleBytes,freeze,code){
  const root=resolve(directory);await mkdir(root); // Never overwrite an earlier registration or partial bundle.
  const put=async(path,bytes)=>{const target=resolve(root,path);if(!target.startsWith(root+sep))fail('bundle_path');
    await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});};
  for(const entry of code){
    const bytes=await readFile(new URL('../../'+entry.path,import.meta.url));
    if(sha(bytes)!==entry.sha256)fail('code_changed');await put(entry.path,bytes);
  }
  await put('frozen/input.json',capsuleBytes);
  const freezeBytes=encode(freeze);await put('frozen/executable.json',freezeBytes);
  const manifest={schemaVersion:2,format:'v1-retest-bundle-v2',capsuleSha256:sha(capsuleBytes),
    capsuleFingerprint:capsule.fingerprint,freezeSha256:sha(freezeBytes),freezeFingerprint:freeze.fingerprint,
    codeFiles:code.length,dependenciesIncluded:false,secretsCopied:false,evaluationPerformed:false,deployable:false};
  await put('frozen/manifest.json',encode(manifest));return manifest;
}
export async function loadRetestBundle(directory,freezeSha256,capsuleSha256,now=new Date().toISOString()){
  const root=await realpath(resolve(directory));
  const file=await bounded(await local(root,'frozen/input.json'),268435456,capsuleSha256);
  const context=verifyRetestCapsule(file.data);
  const frozen=await bounded(await local(root,'frozen/executable.json'),4194304,freezeSha256);
  const code=await releaseExecutionCode(pathToFileURL(root+sep));for(const entry of code)await local(root,entry.path);
  const freeze=verifyRetestFreeze(frozen.data,context,capsuleSha256,code,await releaseRuntime());
  if(freeze.registeredAt>now||context.capsule.preparedAt>now)fail('freeze_in_future');
  return {root,context,freeze,freezeSha256,capsuleSha256};
}
async function requireFrozenExecution(bundle){
  if(await realpath(executionRoot)!==bundle.root)fail('run_from_frozen_bundle');
  // pnpm must resolve workspace imports into the frozen copy, not into the changing application checkout.
  for(const name of ['contracts','analytics','prediction','db','ingestion']){
    const path=join(bundle.root,'packages',name,'package.json'),pkg=JSON.parse(await readFile(path,'utf8'));
    const require=createRequire(path);
    for(const dependency of Object.keys(pkg.dependencies??{}).filter(n=>n.startsWith('@dota/'))){
      const actual=await realpath(require.resolve(dependency));
      const expected=await realpath(join(bundle.root,'packages',dependency.slice(6),'dist','index.js'));
      if(actual!==expected)fail('workspace_dependency_changed');
    }
  }
}
export async function evaluateRetestBundle(bundle){
  await requireFrozenExecution(bundle);
  const output=join(bundle.root,'evaluation');await mkdir(output); // One first attempt, including failures.
  const start={schemaVersion:2,format:'v1-retest-first-scoring-v2',startedAt:new Date().toISOString(),
    freezeSha256:bundle.freezeSha256,freezeFingerprint:bundle.freeze.fingerprint,capsuleSha256:bundle.capsuleSha256};
  const receipt=await open(join(output,'started.json'),'wx');
  try{await receipt.writeFile(encode(start));await receipt.sync();}finally{await receipt.close();}
  try{
    const report=scoreRetestEvaluation(bundle.context,bundle.freeze,bundle.freezeSha256,start);
    const result=await save(join(output,'report.json'),report);
    const binding=retestRegistryBinding(bundle.context,bundle.freeze,bundle.freezeSha256,report);
    await save(join(output,'registry.json'),binding);
    return {status:'retest_evaluation_saved',...result,qualityDecision:report.qualityDecision,
      releaseGatePassed:report.releaseGatePassed,deployable:false,teamAWinProbability:null};
  }catch{
    await save(join(output,'failed.json'),{status:'unavailable',code:'FIRST_SCORING_FAILED',firstScoring:start,
      releaseGatePassed:false,deployable:false,teamAWinProbability:null});fail('first_scoring_failed');
  }
}
export async function replayRetestBundle(bundle){
  await requireFrozenExecution(bundle);
  const report=(await bounded(await local(bundle.root,'evaluation/report.json'),134217728)).data;
  const start=(await bounded(await local(bundle.root,'evaluation/started.json'),65536)).data;
  if(encode(start)!==encode(report.firstScoring)||start.startedAt>new Date().toISOString())fail('first_receipt_changed');
  const binding=retestRegistryBinding(bundle.context,bundle.freeze,bundle.freezeSha256,report);
  const saved=(await bounded(await local(bundle.root,'evaluation/registry.json'),4194304)).data;
  if(encode(binding)!==encode(saved))fail('registry_binding_changed');
  return {status:'retest_evaluation_replayed',qualityDecision:report.qualityDecision,reportFingerprint:report.fingerprint,
    releaseGatePassed:report.releaseGatePassed,deployable:false,teamAWinProbability:null};
}
