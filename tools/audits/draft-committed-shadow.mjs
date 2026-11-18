/** Private read-only SQL058-061 export. Verification never connects to PostgreSQL or providers. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,readdir,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
import {shadowImplementationSha} from '../../apps/api/dist/modules/scenarios/draft-shadow-runtime.js';
import {sha} from './draft-native-export-core.mjs';
import {CommittedShadowSourceSchema,auditCommittedShadow} from './draft-committed-shadow-core.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const clock=column=>sql`to_char(${sql.ref(column)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export async function readCommittedShadow(db){
 return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
   await sql`SET TRANSACTION READ ONLY`.execute(tx);await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
   const count=(await sql`SELECT
     (SELECT count(*)::int FROM owner_draft_captures) AS captures,(SELECT count(*)::int FROM owner_draft_native_bindings) AS bindings,
     (SELECT count(*)::int FROM owner_draft_history_observations) AS observations,(SELECT count(*)::int FROM owner_draft_history_links) AS links,
     (SELECT count(*)::int FROM owner_draft_shadow_runs) AS runs,(SELECT count(*)::int FROM owner_draft_shadow_receipts) AS receipts,
     (coalesce((SELECT sum(octet_length(snapshot_text)) FROM owner_draft_captures),0)+
      coalesce((SELECT sum(octet_length(evidence_text)) FROM owner_draft_native_bindings),0)+
      coalesce((SELECT sum(octet_length(evidence_text)) FROM owner_draft_history_observations),0)+
      coalesce((SELECT sum(octet_length(result_text)) FROM owner_draft_shadow_runs),0))::text AS bytes`.execute(tx)).rows[0];
   assert(count.captures<=100&&count.bindings<=1000&&count.observations<=100&&count.links<=100&&count.runs<=100&&count.receipts<=100&&
     BigInt(count.bytes)<=120n*1024n*1024n,'inventory_limit');
   const captures=(await sql`SELECT id,owner_user_id AS "ownerId",scenario_id AS "scenarioId",revision,${clock('recorded_at')} AS "recordedAt",
     snapshot_text AS "snapshotText",snapshot_sha256 AS "snapshotSha256" FROM owner_draft_captures ORDER BY id`.execute(tx)).rows;
   const bindings=(await sql`SELECT id,owner_user_id AS "ownerId",capture_id AS "captureId",requested_match_id::text AS "matchId",status,
     ${clock('inspected_at')} AS "inspectedAt",${clock('recorded_at')} AS "recordedAt",evidence_text AS "evidenceText",evidence_sha256 AS "evidenceSha256"
     FROM owner_draft_native_bindings ORDER BY id`.execute(tx)).rows;
   const observations=(await sql`SELECT id,owner_user_id AS "ownerId",scenario_id AS "scenarioId",revision,${clock('read_at')} AS "readAt",
     ${clock('observed_at')} AS "observedAt",${clock('recorded_at')} AS "recordedAt",evidence_text AS "evidenceText",evidence_sha256 AS "evidenceSha256"
     FROM owner_draft_history_observations ORDER BY id`.execute(tx)).rows;
   const links=(await sql`SELECT capture_id AS "captureId",observation_id AS "observationId",${clock('recorded_at')} AS "recordedAt"
     FROM owner_draft_history_links ORDER BY capture_id`.execute(tx)).rows;
   const runs=(await sql`SELECT id,capture_id AS "captureId",owner_user_id AS "ownerId",result_text AS "resultText",result_sha256 AS "resultSha256",
     ${clock('recorded_at')} AS "recordedAt",writer_txid AS "writerTxid" FROM owner_draft_shadow_runs ORDER BY id`.execute(tx)).rows;
   const receipts=(await sql`SELECT run_id AS "runId",result_sha256 AS "resultSha256",${clock('observed_committed_at')} AS "observedCommittedAt",
     observer_txid AS "observerTxid" FROM owner_draft_shadow_receipts ORDER BY run_id`.execute(tx)).rows;
   const exportedAt=(await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0].at;
   return CommittedShadowSourceSchema.parse({format:'committed-draft-shadow-source-v1',history:{format:'draft-observation-feature-source-v1',
     native:{format:'native-draft-export-source-v1',exportedAt,syntheticOnly:false,captures,bindings},observations,links},runs,receipts});
 });
}
async function environment(){
 const files=['tools/audits/draft-committed-shadow.mjs','tools/audits/draft-committed-shadow-core.mjs',
   'tools/audits/draft-observation-features-core.mjs','tools/audits/draft-native-export-core.mjs','pnpm-lock.yaml'];
 for(const file of (await readdir(resolve(root,'packages/db/migrations'))).sort())if(/^(012|018|058|059|060|061)_.*\.sql$/.test(file))files.push('packages/db/migrations/'+file);
 for(const name of ['draft-capture-contract','draft-capture-players','draft-target-resolution','draft-native-contract','draft-native-verify','draft-history-contract',
   'draft-shadow-contract','draft-shadow-runtime','draft-shadow-features','draft-shadow-hero','draft-shadow-inference'])
   for(const [dir,ext] of [['src','ts'],['dist','js']])files.push(`apps/api/${dir}/modules/scenarios/${name}.${ext}`);
 for(const dir of ['packages/contracts/dist','packages/db/dist','packages/prediction/dist','.tools/s304-prospective-features-runtime'])
   for(const name of (await readdir(resolve(root,dir))).sort())if(/\.(mjs|js)$/.test(name))files.push(`${dir}/${name}`);
 const code={};for(const file of files.sort())code[file]=sha(await readFile(resolve(root,file)));
 return {node:process.version,implementationSha256:await shadowImplementationSha(),code};
}
async function local(path){
 const base=resolve(root,'.tools'),file=resolve(root,path??''),rel=relative(base,file);
 assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.endsWith('.json'),'local_output_required');
 const actualBase=await realpath(base),actualParent=await realpath(dirname(file)),parentRel=relative(actualBase,actualParent);
 assert(!parentRel.startsWith('..')&&!isAbsolute(parentRel),'local_output_required');return file;
}
export async function writeCommittedShadow(source,path){
 const env=await environment(),result=auditCommittedShadow(source,env.implementationSha256),file=await local(path);
 const report={format:'committed-draft-shadow-file-v1',environment:env,sourceSha256:sha(JSON.stringify(source)),source,result};
 const text=JSON.stringify(report,null,2)+'\n';assert(Buffer.byteLength(text)<=256*1024*1024,'file_size_limit');
 await writeFile(file,text,{flag:'wx'});return {sha256:sha(text),counts:result.counts};
}
export async function verifyCommittedShadow(path,expected){
 assert(/^[a-f0-9]{64}$/.test(expected??''),'external_sha_required');const file=await local(path);
 const actual=await realpath(file),base=await realpath(resolve(root,'.tools')),rel=relative(base,actual);
 assert(!rel.startsWith('..')&&!isAbsolute(rel),'local_output_required');
 assert((await stat(file)).size<=256*1024*1024,'file_size_limit');const bytes=await readFile(file);
 assert.equal(sha(bytes),expected,'external_sha_mismatch');const report=JSON.parse(bytes);
 assert.equal(report.format,'committed-draft-shadow-file-v1');
 assert.deepEqual(Object.keys(report).sort(),['environment','format','result','source','sourceSha256']);
 assert.deepEqual(report.environment,await environment(),'environment_changed');
 assert.equal(report.sourceSha256,sha(JSON.stringify(report.source)),'source_changed');
 const result=auditCommittedShadow(report.source,report.environment.implementationSha256);
 assert.deepEqual(report.result,result,'committed_audit_replay_mismatch');return result;
}
async function main(){
 const [mode,path,expected,...extra]=process.argv.slice(2);assert(!extra.length);
 if(mode==='verify'){const r=await verifyCommittedShadow(path,expected);console.log(JSON.stringify({status:'verified',...r.counts,deployable:false}));return;}
 assert.equal(mode,'capture');assert.equal(expected,undefined);await local(path);
 const before=await environment(),db=createDatabase(process.env.DATABASE_URL);let source;
 try{source=await readCommittedShadow(db);}finally{await db.destroy();}
 assert.deepEqual(await environment(),before,'environment_changed_during_read');
 const saved=await writeCommittedShadow(source,path);console.log(JSON.stringify({status:'exported',...saved,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Экспорт отклонён: проверьте сборку, источник, лимиты, SHA и новый путь .tools. Перезапись запрещена.');process.exitCode=1;
});
