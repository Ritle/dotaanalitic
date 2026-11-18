/** Read-only local collection and immutable shadow result. No production forecast writes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDatabase} from '../../packages/db/dist/index.js';
import {sha} from './draft-native-export-core.mjs';
import {readObservationFeatures} from './draft-observation-features.mjs';
import {calculateShadow} from './draft-shadow-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function environment(){
  const files=['tools/audits/draft-shadow.mjs','tools/audits/draft-shadow-core.mjs','tools/audits/draft-shadow-features-core.mjs',
    'tools/research/player-hero-shadow-feature.mts','tools/research/player-hero-inference.mts',
    'tools/audits/draft-observation-features-core.mjs','tools/audits/draft-observation-features.mjs',
    'packages/db/migrations/060_owner_draft_history_observations.sql','packages/db/migrations/012_verified_dataset_boundary.sql','packages/db/migrations/018_outcome_verifier.sql',
    'tools/audits/draft-native-export-core.mjs','tools/audits/draft-native-export.mjs',
    'tools/research/player-hero-prospective-features.mts','tools/research/player-hero-prospective-capture.mts','tools/research/player-hero-feature.mts',
    'packages/db/migrations/058_owner_draft_captures.sql','packages/db/migrations/059_owner_draft_native_bindings.sql','pnpm-lock.yaml'];
  for(const name of ['draft-capture-contract','draft-target-resolution','draft-native-contract','draft-native-verify','draft-history-contract','draft-capture-players'])
    for(const [dir,ext] of [['src','ts'],['dist','js']])files.push(`apps/api/${dir}/modules/scenarios/${name}.${ext}`);
  for(const dir of ['packages/contracts/dist','packages/db/dist','packages/prediction/dist','.tools/s304-prospective-features-runtime','.tools/s304-shadow-runtime'])
    for(const name of (await readdir(resolve(root,dir))).sort())if(/\.(mjs|js)$/.test(name))files.push(`${dir}/${name}`);
  const code={};for(const file of files.sort())code[file]=sha(await readFile(resolve(root,file)));
  return {node:process.version,code};
}
function local(path){const base=resolve(root,'.tools'),file=resolve(root,path??''),rel=relative(base,file);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.endsWith('.json'),'local_output_required');return file;}
async function limited(path){assert((await stat(path)).size<=256*1024*1024,'file_size_limit');return readFile(path);}
export async function writeShadowResult(source,candidateText,path,calculatedAt=new Date().toISOString()){
  const env=await environment(),result=calculateShadow(source,candidateText,calculatedAt),file=local(path);
  const report={format:'draft-shadow-file-v1',environment:env,sourceSha256:sha(JSON.stringify(source)),source,candidateText,result};
  const bytes=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(bytes)<=256*1024*1024,'file_size_limit');
  await writeFile(file,bytes,{flag:'wx'});return {sha256:sha(bytes),counts:result.counts,scoringPerformed:result.scoringPerformed};
}
export async function verifyShadowResult(path,expected){
  assert(/^[a-f0-9]{64}$/.test(expected??''));const bytes=await limited(local(path));assert.equal(sha(bytes),expected,'external_sha_mismatch');
  const report=JSON.parse(bytes);assert.equal(report.format,'draft-shadow-file-v1');
  assert.deepEqual(Object.keys(report).sort(),['candidateText','environment','format','result','source','sourceSha256']);
  assert.deepEqual(report.environment,await environment(),'environment_changed');
  assert.equal(report.sourceSha256,sha(JSON.stringify(report.source)),'source_changed');
  assert.deepEqual(report.result,calculateShadow(report.source,report.candidateText,report.result.calculatedAt),'shadow_replay_mismatch');return report.result;
}
async function main(){
  const [mode,path,expected,...extra]=process.argv.slice(2);assert(!extra.length);
  if(mode==='verify'){const result=await verifyShadowResult(path,expected);console.log(JSON.stringify({status:'verified',...result.counts}));return;}
  assert.equal(mode,'capture');assert.equal(expected,undefined);local(path);
  const before=await environment(),db=createDatabase(process.env.DATABASE_URL);let source;
  try{source=await readObservationFeatures(db);}finally{await db.destroy();}
  assert.deepEqual(await environment(),before,'environment_changed_during_read');
  const candidateText=await readFile(resolve(root,'.tools/s304-hero-fit-r1/artifact.json'),'utf8');
  const saved=await writeShadowResult(source,candidateText,path);console.log(JSON.stringify({status:'shadow_saved',...saved,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
  console.error('Экспорт отклонён: проверьте сборку, источник, лимиты, SHA и новый путь .tools. Перезапись запрещена.');process.exitCode=1;
});
