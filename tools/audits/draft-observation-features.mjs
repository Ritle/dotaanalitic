/** Export SQL058/059/060 observations and compute reproducible offline inputs. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
import {sha} from './draft-native-export-core.mjs';
import {auditObservationFeatures,ObservationFeatureSourceSchema} from './draft-observation-features-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const clock=column=>sql`to_char(${sql.ref(column)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export async function readObservationFeatures(db){
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    await sql`SET TRANSACTION READ ONLY`.execute(tx);
    await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
    const inventory=(await sql`SELECT
      (SELECT count(*)::int FROM owner_draft_captures) AS captures,
      (SELECT count(*)::int FROM owner_draft_native_bindings) AS bindings,
      (SELECT count(*)::int FROM owner_draft_history_observations) AS observations,
      (SELECT count(*)::int FROM owner_draft_history_links) AS links,
      (COALESCE((SELECT sum(octet_length(snapshot_text)) FROM owner_draft_captures),0)+
       COALESCE((SELECT sum(octet_length(evidence_text)) FROM owner_draft_native_bindings),0)+
       COALESCE((SELECT sum(octet_length(evidence_text)) FROM owner_draft_history_observations),0))::text AS bytes`.execute(tx)).rows[0];
    assert(inventory.captures<=100&&inventory.bindings<=1000&&inventory.observations<=100&&inventory.links<=100&&BigInt(inventory.bytes)<=60n*1024n*1024n,'inventory_limit');
    const captures=(await sql`SELECT id,owner_user_id AS "ownerId",scenario_id AS "scenarioId",revision,
      ${clock('recorded_at')} AS "recordedAt",snapshot_text AS "snapshotText",snapshot_sha256 AS "snapshotSha256"
      FROM owner_draft_captures ORDER BY id`.execute(tx)).rows;
    const bindings=(await sql`SELECT id,owner_user_id AS "ownerId",capture_id AS "captureId",requested_match_id::text AS "matchId",status,
      ${clock('inspected_at')} AS "inspectedAt",${clock('recorded_at')} AS "recordedAt",evidence_text AS "evidenceText",evidence_sha256 AS "evidenceSha256"
      FROM owner_draft_native_bindings ORDER BY id`.execute(tx)).rows;
    const observations=(await sql`SELECT id,owner_user_id AS "ownerId",scenario_id AS "scenarioId",revision,
      ${clock('read_at')} AS "readAt",${clock('observed_at')} AS "observedAt",${clock('recorded_at')} AS "recordedAt",
      evidence_text AS "evidenceText",evidence_sha256 AS "evidenceSha256" FROM owner_draft_history_observations ORDER BY id`.execute(tx)).rows;
    const links=(await sql`SELECT capture_id AS "captureId",observation_id AS "observationId",${clock('recorded_at')} AS "recordedAt"
      FROM owner_draft_history_links ORDER BY capture_id`.execute(tx)).rows;
    const exportedAt=(await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0].at;
    return ObservationFeatureSourceSchema.parse({format:'draft-observation-feature-source-v1',
      native:{format:'native-draft-export-source-v1',exportedAt,syntheticOnly:false,captures,bindings},observations,links});
  });
}
async function environment(){
  const files=['tools/audits/draft-observation-features-core.mjs','tools/audits/draft-observation-features.mjs',
    'packages/db/migrations/060_owner_draft_history_observations.sql','packages/db/migrations/012_verified_dataset_boundary.sql','packages/db/migrations/018_outcome_verifier.sql',
    'tools/audits/draft-native-export-core.mjs','tools/audits/draft-native-export.mjs',
    'tools/research/player-hero-prospective-features.mts','tools/research/player-hero-prospective-capture.mts','tools/research/player-hero-feature.mts',
    'packages/db/migrations/058_owner_draft_captures.sql','packages/db/migrations/059_owner_draft_native_bindings.sql','pnpm-lock.yaml'];
  for(const name of ['draft-capture-contract','draft-target-resolution','draft-native-contract','draft-native-verify','draft-history-contract','draft-capture-players'])
    for(const [dir,ext] of [['src','ts'],['dist','js']])files.push(`apps/api/${dir}/modules/scenarios/${name}.${ext}`);
  for(const dir of ['packages/contracts/dist','packages/db/dist','packages/prediction/dist','.tools/s304-prospective-features-runtime'])
    for(const name of (await readdir(resolve(root,dir))).sort())if(/\.(mjs|js)$/.test(name))files.push(`${dir}/${name}`);
  const code={};for(const file of files.sort())code[file]=sha(await readFile(resolve(root,file)));
  return {node:process.version,code};
}
function local(path){const base=resolve(root,'.tools'),file=resolve(root,path??''),rel=relative(base,file);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.endsWith('.json'),'local_output_required');return file;}
async function limited(path){assert((await stat(path)).size<=256*1024*1024,'file_size_limit');return readFile(path);}
export async function writeObservationFeatures(source,path){
  const env=await environment(),result=auditObservationFeatures(source),file=local(path);
  const report={format:'draft-observation-feature-file-v1',environment:env,sourceSha256:sha(JSON.stringify(source)),source,result};
  const bytes=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(bytes)<=256*1024*1024,'file_size_limit');
  await writeFile(file,bytes,{flag:'wx'});return {sha256:sha(bytes),counts:result.counts};
}
export async function verifyObservationFeatures(path,expected){
  assert(/^[a-f0-9]{64}$/.test(expected??''));const bytes=await limited(local(path));assert.equal(sha(bytes),expected,'external_sha_mismatch');
  const report=JSON.parse(bytes);assert.equal(report.format,'draft-observation-feature-file-v1');
  assert.deepEqual(Object.keys(report).sort(),['environment','format','result','source','sourceSha256']);
  assert.deepEqual(report.environment,await environment(),'environment_changed');
  assert.equal(report.sourceSha256,sha(JSON.stringify(report.source)),'source_changed');
  assert.deepEqual(report.result,auditObservationFeatures(report.source),'audit_replay_mismatch');return report.result;
}
async function main(){
  const [mode,path,expected,...extra]=process.argv.slice(2);assert(!extra.length);
  if(mode==='verify'){const result=await verifyObservationFeatures(path,expected);console.log(JSON.stringify({status:'verified',...result.counts}));return;}
  assert.equal(mode,'capture');assert.equal(expected,undefined);local(path);
  const before=await environment(),db=createDatabase(process.env.DATABASE_URL);let source;
  try{source=await readObservationFeatures(db);}finally{await db.destroy();}
  assert.deepEqual(await environment(),before,'environment_changed_during_read');
  const saved=await writeObservationFeatures(source,path);console.log(JSON.stringify({status:'exported',...saved,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
  console.error('Экспорт отклонён: проверьте сборку, источник, лимиты, SHA и новый путь .tools. Перезапись запрещена.');process.exitCode=1;
});
