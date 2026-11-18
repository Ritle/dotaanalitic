import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,realpath} from 'node:fs/promises';
import {resolve,relative,join,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const policyPath='tools/research/player-hero-conditional-future-policy.json',policySha='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f';
const Ref=z.object({directory:z.string().min(1).max(1024),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const Spec=z.object({format:z.literal('conditional-evaluation-files-input-v1'),source:Ref,enrollment:Ref}).strict();
async function privatePath(path,existing=true){
 const full=resolve(root,path),base=await realpath(join(root,'.tools'));
 const checked=existing?await realpath(full):join(await realpath(dirname(full)),basename(full));
 const rel=relative(base,checked);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'),'private_path_required');return full;
}
async function bytes(path){const p=await privatePath(path),s=await stat(p);assert(s.isFile()&&s.size<=32*1024*1024,'bounded_file_required');return readFile(p);}
async function pinned(path,expected){const b=await bytes(path);assert.equal(sha(b),expected,'pinned_source_changed');return JSON.parse(b);}
async function parent(ref,script){
 const directory=await privatePath(ref.directory),manifest=await pinned(join(directory,'manifest.json'),ref.manifestSha256);
 const r=spawnSync(process.execPath,[script,'verify',directory,ref.manifestSha256],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 assert.equal(r.status,0,'parent_replay_failed');
 const input=await pinned(manifest.sources.input.path,manifest.sources.input.sha256);
 const archive=await pinned(manifest.sources.archive.path,manifest.sources.archive.sha256);
 return {manifest,input,archive};
}
async function main(){
 const [mode,...args]=process.argv.slice(2);assert(mode==='build'?args.length===3:mode==='verify'&&args.length===2,'arguments');
 let directory,ref,saved;
 if(mode==='build'){
  const [specPath,specSha,out]=args;assert(/^[a-f0-9]{64}$/.test(specSha),'expected_hash_required');
  directory=await privatePath(out,false);ref={path:relative(root,await privatePath(specPath)),sha256:specSha};
 }else{
  directory=await privatePath(args[0]);saved=await pinned(join(directory,'manifest.json'),args[1]);ref=saved.input;
 }
 const spec=Spec.parse(await pinned(ref.path,ref.sha256)),policyBytes=await readFile(join(root,policyPath));
 assert.equal(sha(policyBytes),policySha,'policy_changed');const policy=JSON.parse(policyBytes);
 const candidateBytes=await bytes(policy.candidate.artifactPath);assert.equal(sha(candidateBytes),policy.candidate.artifactSha256,'candidate_changed');
 const source=await parent(spec.source,'tools/research/conditional-future-source-files.mjs');
 const enrollment=await parent(spec.enrollment,'tools/research/conditional-enrollment-files.mjs');
 assert.equal(source.manifest.sources.archive.sha256,enrollment.manifest.sources.archive.sha256,'archive_mismatch');
 const exclusion=policy.independence.exposure,ledgerFile=await pinned(exclusion.path,exclusion.sha256),ledger=ledgerFile.result.ledger;
 const requiredExposure=source.archive.syntheticOnly?source.input.exposure:
  {sourceSha256:exclusion.sha256,mapIds:ledger.mapIds,seriesKeys:ledger.canonicalSeriesKeys};
 const {buildConditionalEvaluationBundle}=await import('./conditional-evaluation.mjs');
 const result=buildConditionalEvaluationBundle({enrollmentInput:enrollment.input,featureInput:source.input,archive:source.archive,requiredExposure});
 const outputs=Object.fromEntries(Object.entries(result).map(([name,body])=>[name+'.json',JSON.stringify(body,null,2)+'\n']));
 const paths=[policyPath,'tools/research/conditional-evaluation.mjs','tools/research/conditional-evaluation-files.mjs'];
 const manifest={format:'conditional-evaluation-files-v1',node:process.version,input:ref,parents:spec,
  policySha256:policySha,candidate:{path:policy.candidate.artifactPath,sha256:policy.candidate.artifactSha256},
  requiredExposure:{path:exclusion.path,sha256:exclusion.sha256,applied:!source.archive.syntheticOnly},
  code:Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(join(root,p)))]))),
  artifacts:Object.fromEntries(Object.entries(outputs).map(([file,text])=>[file,sha(text)])),
  syntheticOnly:source.archive.syntheticOnly,registrationAllowed:false,evaluationAllowed:false,collectionAllowed:false,deployable:false};
 const text=JSON.stringify(manifest,null,2)+'\n';
 if(mode==='build'){
  await mkdir(directory);for(const [file,body] of Object.entries(outputs))await writeFile(join(directory,file),body,{flag:'wx'});
  await writeFile(join(directory,'manifest.json'),text,{flag:'wx'});
 }else{
  assert.deepEqual(saved,manifest,'manifest_replay_mismatch');
  for(const [file,body] of Object.entries(outputs))assert.equal((await bytes(join(directory,file))).toString('utf8'),body,'output_replay_mismatch');
 }
 console.log(JSON.stringify({status:mode==='build'?'evaluation_bundle_saved':'evaluation_bundle_verified',manifestSha256:sha(text),
  syntheticOnly:manifest.syntheticOnly,cohortStatus:result.cohort.status,counts:result.cohort.counts,pairedCoverage:result.cohort.pairedCoverage,
  scoringPerformed:false,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 console.error(error.code==='EEXIST'?'Каталог уже существует; используйте verify или новый путь.':
  'Подготовка оценки отклонена: проверьте SHA, совместимость источников, окно, исключения и пути внутри .tools.');process.exitCode=1;
});
