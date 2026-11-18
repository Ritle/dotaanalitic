import assert from 'node:assert/strict';
import {readFile,open,mkdir,realpath,stat,readdir,rmdir} from 'node:fs/promises';
import {resolve,relative,join,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {prepareRegistration,verifyRegistration,bindAssessment,verifyAssessmentChain,registrationDigest} from './conditional-registration.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const serialize=v=>JSON.stringify(v,null,2)+'\n',emptyHead='-';
async function privatePath(path,existing=true){
 const full=resolve(root,path),base=await realpath(join(root,'.tools'));
 const checked=existing?await realpath(full):join(await realpath(dirname(full)),basename(full));
 const rel=relative(base,checked);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'),'private_path_required');return full;
}
async function bytes(path){const p=await privatePath(path),s=await stat(p);assert(s.isFile()&&s.size<=16*1024*1024,'bounded_file_required');return readFile(p);}
async function pinned(path,expected){const b=await bytes(path);assert.equal(sha(b),expected,'external_hash_mismatch');return JSON.parse(b);}
async function exclusive(path,value){
 await privatePath(path,false);const f=await open(path,'wx');
 try{await f.writeFile(serialize(value));await f.sync();}finally{await f.close();}
}
export async function createSyntheticRegistration(path,plan,recordedAt){
 const registration=prepareRegistration(plan,recordedAt),directory=await privatePath(path,false);
 await mkdir(directory);await exclusive(join(directory,'registration.json'),registration);
 return {registrationSha256:sha(serialize(registration)),registrationFingerprint:registration.fingerprint,headSha256:emptyHead};
}
async function readJournal(path,registrationSha256,expectedHead,ownsLock){
 const directory=await privatePath(path),registration=verifyRegistration(await pinned(join(directory,'registration.json'),registrationSha256));
 const entries=await readdir(directory);assert(ownsLock||!entries.includes('.append-lock'),'journal_write_incomplete');
 const names=entries.filter(n=>n!=='.append-lock'&&n!=='registration.json').sort();
 assert(names.length<=1000&&names.every((n,i)=>n===String(i+1).padStart(6,'0')+'.json'),'journal_gap_or_unknown_file');
 const commits=[];for(const n of names)commits.push(JSON.parse(await bytes(join(directory,n))));
 verifyAssessmentChain(registration,commits.map(r=>r.commit));
 for(const r of commits){assert.deepEqual(Object.keys(r).sort(),['commit','executionRef']);
  assert.deepEqual(Object.keys(r.executionRef).sort(),['directory','manifestSha256']);
  assert.equal(r.commit.execution.manifestSha256,r.executionRef.manifestSha256,'execution_reference_changed');}
 const headSha256=names.length?sha(await bytes(join(directory,names.at(-1)))):emptyHead;
 assert.equal(headSha256,expectedHead,'journal_head_changed');
 return {registration,commits,headSha256};
}
export async function readSyntheticJournal(path,registrationSha256,expectedHead){return readJournal(path,registrationSha256,expectedHead,false);}
export async function appendSyntheticAssessment(path,registrationSha256,expectedHead,execution,executionRef,reason,recordedAt){
 const directory=await privatePath(path),lock=join(directory,'.append-lock');
 await mkdir(lock); // A concurrent writer fails; callers reread the head, never overwrite.
 let writeStarted=false,committed=false;
 try{
  const journal=await readJournal(directory,registrationSha256,expectedHead,true),previous=journal.commits.at(-1)?.commit??null;
  const commit=bindAssessment(journal.registration,execution,previous,reason,recordedAt);
  assert(!journal.commits.some(r=>r.commit.execution.reportSha256===execution.reportSha256||r.commit.execution.manifestSha256===execution.manifestSha256),'reused_assessment');
  assert.equal(executionRef.manifestSha256,execution.manifestSha256,'execution_reference_mismatch');await privatePath(executionRef.directory);
  const row={commit,executionRef};writeStarted=true;await exclusive(join(directory,String(commit.revision).padStart(6,'0')+'.json'),row);committed=true;
  return {revision:commit.revision,headSha256:sha(serialize(row)),registrationSha256};
 }finally{if(!writeStarted||committed)await rmdir(lock);} // An uncertain write/fsync stays locked for explicit recovery.
}
export async function loadSyntheticExecution(directory,manifestSha256){
 directory=await privatePath(directory);const manifest=await pinned(join(directory,'manifest.json'),manifestSha256);
 assert.equal(manifest.syntheticOnly,true,'real_execution_not_authorized');
 const verified=spawnSync(process.execPath,['tools/research/conditional-evaluator.mjs','verify',directory,manifestSha256],
  {cwd:root,encoding:'utf8',timeout:180000,maxBuffer:1024*1024});assert.equal(verified.status,0,'evaluation_replay_failed');
 const input=await pinned(join(directory,'input.json'),manifest.artifacts['input.json']);
 const report=await pinned(join(directory,'report.json'),manifest.artifacts['report.json']);
 const bundle=await pinned(join(await privatePath(manifest.parent.directory),'manifest.json'),manifest.parent.manifestSha256);
 const source=await pinned(join(await privatePath(bundle.parents.source.directory),'manifest.json'),bundle.parents.source.manifestSha256);
 const enrollment=await pinned(join(await privatePath(bundle.parents.enrollment.directory),'manifest.json'),bundle.parents.enrollment.manifestSha256);
 const code={};for(const m of [manifest,bundle,source,enrollment])for(const [p,h] of Object.entries(m.code)){
  if(code[p])assert.equal(code[p],h,'inconsistent_executable_graph');code[p]=h;
 }
 for(const p of ['tools/research/conditional-registration.mjs','tools/research/conditional-registration-files.mjs'])code[p]=sha(await readFile(join(root,p)));
 const environmentSha256=registrationDigest({node:manifest.node,pythonEnvironment:manifest.pythonEnvironment,threads:manifest.threads});
 return {format:'conditional-assessment-binding-v1',syntheticOnly:true,manifestSha256,inputSha256:manifest.artifacts['input.json'],
  reportSha256:manifest.artifacts['report.json'],policySha256:manifest.policySha256,candidateSha256:manifest.candidateSha256,
  exposureSha256:bundle.requiredExposure.sha256,code,environmentSha256,scope:input.bundle.cohort.scope,window:input.bundle.cohort.window,
  schedule:input.schedule,status:report.status,scoringPerformed:report.scoringPerformed,releaseGatePassed:report.releaseGatePassed,
  activationAllowed:report.activationAllowed,deployable:report.deployable};
}
async function main(){
 const [mode,...args]=process.argv.slice(2);let result;
 if(mode==='create-synthetic'){
  assert.equal(args.length,4);const [planPath,planSha,path,at]=args;
  result=await createSyntheticRegistration(path,await pinned(planPath,planSha),at);
 }else if(mode==='append-synthetic'){
  assert(args.length===6||args.length===7);const [path,regSha,head,executionDir,executionSha,at,reason]=args;
  const execution=await loadSyntheticExecution(executionDir,executionSha);
  result=await appendSyntheticAssessment(path,regSha,head,execution,{directory:relative(root,await privatePath(executionDir)),manifestSha256:executionSha},reason??null,at);
 }else if(mode==='verify-synthetic'){
  assert.equal(args.length,3);const journal=await readSyntheticJournal(...args);
  for(const r of journal.commits){const replay=await loadSyntheticExecution(r.executionRef.directory,r.executionRef.manifestSha256);
   assert.equal(registrationDigest(replay),registrationDigest(r.commit.execution),'execution_changed');}
  result={revisions:journal.commits.length,firstStatus:journal.commits[0]?.commit.execution.status??null,headSha256:journal.headSha256};
 }else throw Error('arguments');
 console.log(JSON.stringify({status:'synthetic_contract_verified',...result,realRegistration:false,realEvaluationAllowed:false,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 console.error(error.code==='EEXIST'?'Запись уже существует или журнал занят; перечитайте его состояние.':
  'Проверка регистрации отклонена: проверьте SHA, сроки, состав файлов и цепочку результатов.');process.exitCode=1;
});
