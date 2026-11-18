import assert from 'node:assert/strict';
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildExposureLedger,extractExposure,sha} from './exposure-ledger-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const codeFiles=['tools/research/exposure-ledger-core.mjs','tools/research/exposure-ledger.mjs','tools/research/exposure-source-discovery.mjs'];
const MAX=128*1024*1024;
const hash = x => assert(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'invalid_sha');
function local(path,output=false) {
  assert(typeof path==='string','path_required');
  const full=resolve(root,path),rel=relative(root,full).replaceAll('\\','/');
  assert(rel&&!rel.startsWith('../')&&!isAbsolute(rel)&&rel.endsWith('.json'),'repository_json_required');
  assert(output?rel.startsWith('.tools/'):(rel.startsWith('.tools/')||rel.startsWith('docs/evidence/')),'path_scope');
  assert(!/(^|\/)(private-owner|node_modules|corepack|\.git)(\/|$)/i.test(rel),'private_or_dependency_path');
  return full;
}
async function contained(path) {
  const actual=await realpath(path),rel=relative(root,actual);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'symlink_outside_repository');
  assert(!/(^|[\\/])(private-owner|node_modules|corepack|\.git)([\\/]|$)/i.test(rel),'private_or_dependency_path');
}
async function json(path,expected) {
  const full=local(path);await contained(full);assert((await stat(full)).size<=MAX,'file_limit');
  const bytes=await readFile(full);assert(bytes.length<=MAX,'file_limit');
  if(expected!==undefined){hash(expected);assert.equal(sha(bytes),expected,'source_sha_changed');}
  return {value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),sha256:sha(bytes)};
}
async function code() {return Object.fromEntries(await Promise.all(codeFiles.map(async p=>[p,sha(await readFile(resolve(root,p)))])));}
async function assemble(plan) {
  assert.equal(plan.format,'exposure-source-plan-v1');assert.equal(plan.registrationAllowed,false);
  assert(Array.isArray(plan.sources)&&plan.sources.length>0&&plan.sources.length<=5000,'source_limit');
  for(const survey of plan.surveys??[])await json(survey.path,survey.sha256);
  const sources=[];
  for(const s of plan.sources) {
    const {value}=await json(s.path,s.sha256),extracted=extractExposure(s.adapter,value);
    sources.push({path:s.path,adapter:s.adapter,sha256:s.sha256,...extracted});
  }
  const input={format:'exposure-ledger-input-v1',capturedAt:plan.capturedAt,sources,pendingReview:plan.pendingReview};
  return {input,result:buildExposureLedger(input)};
}
export async function captureLedger(planPath,outputPath) {
  const output=local(outputPath,true);await contained(dirname(output));
  const plan=await json(planPath),body=await assemble(plan.value);
  const report={format:'exposure-ledger-file-v1',sourcePlan:{path:planPath,sha256:plan.sha256},
    environment:{node:process.version,code:await code()},...body};
  const bytes=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(bytes)<=MAX,'file_limit');
  await writeFile(output,bytes,{flag:'wx'});return {sha256:sha(bytes),summary:report.result.summary};
}
export async function verifyLedger(path,expected) {
  hash(expected);const saved=(await json(path,expected)).value;
  assert.equal(saved.format,'exposure-ledger-file-v1');
  assert.deepEqual(Object.keys(saved).sort(),['environment','format','input','result','sourcePlan']);
  assert.deepEqual(saved.environment,{node:process.version,code:await code()},'environment_changed');
  const plan=await json(saved.sourcePlan.path,saved.sourcePlan.sha256);
  const replay=await assemble(plan.value);
  assert.deepEqual(saved.input,replay.input,'source_projection_changed');
  assert.deepEqual(saved.result,replay.result,'ledger_replay_mismatch');
  return {sha256:expected,summary:replay.result.summary,verified:true};
}
async function captureDatabase(path) {
  const output=local(path,true);await contained(dirname(output));
  const {createDatabase,sql}=await import('../../packages/db/dist/index.js');
  const db=createDatabase(process.env.DATABASE_URL);
  try {
    const result=await db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
      const n=(await sql`SELECT count(*)::int AS n FROM matches`.execute(tx)).rows[0].n;assert(n<=100000,'map_limit');
      const maps=(await sql`SELECT m.id::text AS "matchId",m.series_id::text AS "localSeriesId",
        s.provider,s.provider_series_id AS "providerSeriesId" FROM matches m LEFT JOIN series s ON s.id=m.series_id ORDER BY m.id`.execute(tx)).rows;
      const capturedAt=(await sql`SELECT clock_timestamp() AS at`.execute(tx)).rows[0].at.toISOString();
      return {format:'exposure-database-snapshot-v1',capturedAt,readOnly:true,maps};
    });
    extractExposure('database',result);
    const bytes=JSON.stringify(result,null,2)+'\n';await writeFile(output,bytes,{flag:'wx'});
    return {sha256:sha(bytes),maps:result.maps.length,capturedAt:result.capturedAt};
  } finally {await db.destroy();}
}
async function main() {
  const [mode,a,b,...extra]=process.argv.slice(2);assert(!extra.length,'arguments');
  let result;
  if(mode==='capture-db'){assert(b===undefined,'arguments');result=await captureDatabase(a);}
  else if(mode==='capture')result=await captureLedger(a,b);
  else {assert.equal(mode,'verify');result=await verifyLedger(a,b);}
  console.log(JSON.stringify({...result,registrationAllowed:false,collectionAllowed:false,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
  console.error('Реестр отклонён: проверьте формат, SHA источников и новый путь .tools. Перезапись запрещена.');
  process.exitCode=1;
});
