/** Separate immutable audit file. No binding writes, provider calls or prediction. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createDatabase} from '../../packages/db/dist/index.js';
import {readDraftTargetSources} from '../../apps/api/dist/modules/scenarios/draft-target-source.js';
import {resolveDraftTargets} from '../../apps/api/dist/modules/scenarios/draft-target-resolution.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const paths=['apps/api/src/modules/scenarios/draft-target-resolution.ts','apps/api/src/modules/scenarios/draft-target-source.ts',
  'apps/api/dist/modules/scenarios/draft-target-resolution.js','apps/api/dist/modules/scenarios/draft-target-source.js',
  'apps/api/src/modules/scenarios/draft-capture-contract.ts','apps/api/dist/modules/scenarios/draft-capture-contract.js',
  'apps/api/src/modules/scenarios/draft-capture-repository.ts','packages/db/migrations/018_outcome_verifier.sql',
  'apps/api/dist/modules/scenarios/draft-capture-repository.js','packages/db/dist/outcome-verifier.js','packages/db/dist/v1-registry.js','packages/db/dist/temporal.js',
  'packages/db/migrations/012_verified_dataset_boundary.sql','tools/audits/draft-target-resolution.mjs','pnpm-lock.yaml'];
async function code(){return Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(resolve(root,p)))])));}
function local(path){const p=resolve(root,path??''),rel=relative(root,p);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.endsWith('.json'));return p;}
async function limited(path){assert((await stat(path)).size<=64*1024*1024);return readFile(path);}
export async function verifyDraftTargetAudit(path,expected){
  assert(/^[a-f0-9]{64}$/.test(expected??''));const bytes=await limited(path);assert.equal(hash(bytes),expected);
  const report=JSON.parse(bytes);assert.equal(report.format,'draft-target-audit-file-v1');assert.deepEqual(report.code,await code());
  assert.deepEqual(Object.keys(report).sort(),['code','format','result','source','sourceSha256']);
  assert.equal(hash(JSON.stringify(report.source)),report.sourceSha256);
  assert.deepEqual(report.result,resolveDraftTargets(report.source));return report;
}
export async function saveDraftTargetAudit(source,path){
  const manifest=await code(),result=resolveDraftTargets(source);
  const report={format:'draft-target-audit-file-v1',source,sourceSha256:hash(JSON.stringify(source)),code:manifest,result};
  const bytes=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(bytes)<=64*1024*1024,'audit_size_limit');
  await writeFile(local(path),bytes,{flag:'wx'});return {sha256:hash(bytes),result};
}
async function main(){
  const [mode,path,expected,...extra]=process.argv.slice(2);assert(extra.length===0&&['capture','verify'].includes(mode));
  const file=local(path);
  if(mode==='verify'){const r=await verifyDraftTargetAudit(file,expected);console.log(JSON.stringify({status:'verified',captures:r.result.items.length,matched:r.result.matched,prestartVerified:0}));return;}
  assert(expected===undefined);const manifest=await code();const db=createDatabase(process.env.DATABASE_URL);
  let source;try{source=await readDraftTargetSources(db);}finally{await db.destroy();}
  assert.deepEqual(await code(),manifest,'code_changed_during_capture');
  const {sha256,result}=await saveDraftTargetAudit(source,file);
  console.log(JSON.stringify({status:'saved',sha256,captures:result.items.length,matched:result.matched,prestartVerified:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
  console.error('Проверка карты отклонена: проверьте сборку, БД, путь нового файла и SHA. Перезапись запрещена.');process.exitCode=1;
});
