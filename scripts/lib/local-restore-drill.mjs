import {mkdir,readFile,writeFile,realpath,copyFile,stat,chmod,open,constants} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {createDatabase,sql,V1RuntimeRepository,V1JournalRepository} from '../../packages/db/dist/index.js';
import {readV1RegistryBundle} from './v1-registry-bundle.mjs';

const execute=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
const fail=code=>{throw new Error(code);};
const check=(condition,code)=>{if(!condition)fail(code);};
const localPath=p=>relative(root,p).split(sep).join('/');
export function sourceConnection(value){
  let u;try{u=new URL(value);}catch{fail('LOCAL_DATABASE_REQUIRED');}
  check(['postgres:','postgresql:'].includes(u.protocol)&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&!u.search&&!u.hash,'LOCAL_DATABASE_REQUIRED');
  const database=decodeURIComponent(u.pathname.slice(1));
  check(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)&&u.username,'LOCAL_DATABASE_REQUIRED');
  return {url:u.toString(),database,host:u.hostname.replace(/^\[|\]$/g,''),port:u.port||'5432',user:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};
}
export function assertCreatedTarget(name,source,created){
  check(created&&/^codex_restore_[a-f0-9]{12}$/.test(name)&&name!==source,'UNSAFE_RESTORE_TARGET');
}
const connectionArgs=(c,database)=>[`--host=${c.host}`,`--port=${c.port}`,`--username=${c.user}`,`--dbname=${database}`,'--no-password'];
export function postgresEnvironment(c){
  // libpq hostaddr/service/options defaults must not redirect or alter our explicit connection.
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key)));
  return {...inherited,PGPASSWORD:c.password,PGSSLMODE:'disable',PGCONNECT_TIMEOUT:'10'};
}
async function pgCommand(binary,args,c){
  try{return await execute(binary,args,{windowsHide:true,timeout:180000,maxBuffer:1048576,
    env:postgresEnvironment(c)});}
  catch{fail('POSTGRES_COMMAND_FAILED');}
}
async function inventory(db){
  const tables=(await sql`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    ORDER BY n.nspname,c.relname`.execute(db)).rows;
  const result=[];
  for(const t of tables){
    const row=(await sql`SELECT count(*)::text AS n,md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS fingerprint
      FROM (SELECT md5(to_jsonb(t)::text) AS h FROM ${sql.id(t.schema,t.name)} t) x`.execute(db)).rows[0];
    result.push({schema:t.schema,table:t.name,...row});
  }
  return result;
}
async function readSnapshots(db){
  const forecasts=(await sql`SELECT owner_user_id,request_id,snapshot_sha256 FROM v1_runtime_snapshots ORDER BY request_id`.execute(db)).rows;
  const reports=(await sql`SELECT owner_user_id,request_id,report_sha256 FROM v1_journal_reports ORDER BY request_id`.execute(db)).rows;
  check(forecasts.length<=5000&&reports.length<=5000,'SNAPSHOT_READ_LIMIT');
  const runtime=new V1RuntimeRepository(db),journal=new V1JournalRepository(db);
  for(const f of forecasts)check((await runtime.get(f.owner_user_id,f.request_id))?.sha256===f.snapshot_sha256,'FORECAST_REPLAY_FAILED');
  for(const r of reports)check((await journal.get(r.owner_user_id,r.request_id)).sha256===r.report_sha256,'REPORT_REPLAY_FAILED');
  return {forecasts:forecasts.length,reports:reports.length};
}
async function copyBundle(directory,destination){
  const source=await realpath(directory);
  async function contained(p){
    check(typeof p==='string'&&!p.split(/[\\/]/).some(s=>s==='..'||s==='')&&!/^([A-Za-z]:|[\\/])/.test(p),'BUNDLE_PATH_INVALID');
    const target=await realpath(resolve(source,p));check(target.startsWith(source+sep),'BUNDLE_PATH_INVALID');return target;
  }
  const configBytes=await readFile(await contained('frozen/config.json')),config=JSON.parse(configBytes);
  const configSha=hash(configBytes),freezeSha=config.freeze?.sha256;
  const verified=await readV1RegistryBundle(source,configSha,freezeSha);
  const freeze=JSON.parse(verified.freezeText);
  const files=[...new Set([...freeze.code.map(f=>f.path),'frozen/config.json',config.planPath,config.cataloguePath,config.developmentPath,config.candidatePath,config.freeze.path])].sort();
  const copied=[];
  for(const p of files){
    const original=await contained(p),target=join(destination,p);await mkdir(resolve(target,'..'),{recursive:true,mode:0o700});
    await copyFile(original,target,constants.COPYFILE_EXCL);await chmod(target,0o600);const bytes=await readFile(target);copied.push({path:p,sha256:hash(bytes)});
  }
  await readV1RegistryBundle(destination,configSha,freezeSha);
  return {configSha256:configSha,freezeSha256:freezeSha,files:copied};
}

/** A local drill only. No supplied archive or existing restore target is ever accepted. */
export async function runLocalRestoreDrill({databaseUrl,pgBin,bundles=[]},inspectRestored=async()=>{}){
  const c=sourceConnection(databaseUrl),bin=await realpath(pgBin),suffix=process.platform==='win32'?'.exe':'';
  const dump=join(bin,'pg_dump'+suffix),restore=join(bin,'pg_restore'+suffix);
  for(const executable of [dump,restore])check(/PostgreSQL\) 16\./.test((await pgCommand(executable,['--version'],c)).stdout),'POSTGRES_16_REQUIRED');
  const base=join(root,'.tools','backups');await mkdir(base,{recursive:true,mode:0o700});
  check(await realpath(base)===resolve(await realpath(root),'.tools','backups'),'BACKUP_PATH_INVALID');
  const directory=join(base,'restore-'+randomBytes(12).toString('hex'));await mkdir(directory,{mode:0o700});
  const archive=join(directory,'database.dump'),source=createDatabase(c.url),targetName='codex_restore_'+randomBytes(6).toString('hex');
  let target,created=false,dropped=false,targetOid,backup,report,problem;
  try{
    const copiedBundles=[];
    for(let i=0;i<bundles.length;i++)copiedBundles.push(await copyBundle(bundles[i],join(directory,'bundle-'+i)));
    backup=await source.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);await sql`SET LOCAL TIME ZONE 'UTC'`.execute(tx);
      check(Number((await sql`SHOW server_version_num`.execute(tx)).rows[0].server_version_num)>=160000&&
        Number((await sql`SHOW server_version_num`.execute(tx)).rows[0].server_version_num)<170000,'POSTGRES_16_REQUIRED');
      const artifacts=(await sql`SELECT DISTINCT freeze_sha256 FROM v1_model_artifacts`.execute(tx)).rows;
      check(artifacts.every(a=>copiedBundles.some(b=>b.freezeSha256===a.freeze_sha256)),'MODEL_BUNDLE_REQUIRED');
      const snapshot=(await sql`SELECT pg_export_snapshot() AS snapshot`.execute(tx)).rows[0].snapshot;
      const before=await inventory(tx);
      await pgCommand(dump,[...connectionArgs(c,c.database),'--format=custom','--no-owner','--no-acl',`--snapshot=${snapshot}`,`--file=${archive}`],c);
      await chmod(archive,0o600);
      const file=await open(archive,'r'),header=Buffer.alloc(5);try{await file.read(header,0,5,0);}finally{await file.close();}
      check(header.toString()==='PGDMP','ARCHIVE_FORMAT_INVALID');
      return {format:'local-postgres-backup-v1',createdAt:new Date().toISOString(),archive:{file:'database.dump',sha256:await fileHash(archive),bytes:(await stat(archive)).size},
        bundles:copiedBundles,tables:before,scope:'single database and supplied frozen bundles; roles, secrets and installed dependencies are not included'};
    });
    await writeFile(join(directory,'backup.json'),JSON.stringify(backup,null,2)+'\n',{flag:'wx',mode:0o600});
    check(await fileHash(archive)===backup.archive.sha256,'ARCHIVE_SHA_MISMATCH');
    assertCreatedTarget(targetName,c.database,true);
    await sql`CREATE DATABASE ${sql.id(targetName)} TEMPLATE template0`.execute(source);created=true;
    targetOid=(await sql`SELECT oid::text AS oid FROM pg_database WHERE datname=${targetName}`.execute(source)).rows[0].oid;
    await pgCommand(restore,[...connectionArgs(c,targetName),'--exit-on-error','--single-transaction','--no-owner','--no-acl',archive],c);
    const targetUrl=new URL(c.url);targetUrl.pathname='/'+targetName;target=createDatabase(targetUrl.toString());
    const comparison=await target.transaction().execute(async tx=>{
      await sql`SET LOCAL TIME ZONE 'UTC'`.execute(tx);check(isDeepStrictEqual(await inventory(tx),backup.tables),'RESTORED_DATA_MISMATCH');
      return {tables:backup.tables.length,rows:backup.tables.reduce((n,t)=>n+BigInt(t.n),0n).toString()};
    });
    // Revoke only in the new restored database, before any application is exposed.
    const revoked=(await sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL RETURNING token_hash`.execute(target)).rows.length;
    check((await sql`SELECT 1 FROM auth_sessions WHERE revoked_at IS NULL LIMIT 1`.execute(target)).rows.length===0,'RESTORED_SESSION_REVOCATION_FAILED');
    const replay=await readSnapshots(target);
    await inspectRestored(target,{databaseUrl:targetUrl.toString()});
    check((await sql`SELECT 1 FROM auth_sessions WHERE revoked_at IS NULL LIMIT 1`.execute(target)).rows.length===0,'RESTORED_SESSION_REVOCATION_FAILED');
    const after=await target.transaction().execute(async tx=>{await sql`SET LOCAL TIME ZONE 'UTC'`.execute(tx);return inventory(tx);});
    check(isDeepStrictEqual(after.filter(t=>t.table!=='auth_sessions'||t.schema!=='public'),backup.tables.filter(t=>t.table!=='auth_sessions'||t.schema!=='public')),'RESTORED_DATA_CHANGED');
    report={format:'local-restore-drill-v1',status:'verified',archiveSha256:backup.archive.sha256,...comparison,...replay,sessionsRevoked:revoked,
      bundlesVerified:copiedBundles.length,sourceReadOnly:true,restoredSessionsAllRevoked:true,targetDropped:false};
  }catch(error){problem=error;}
  finally{
    try{await target?.destroy();}catch(error){problem=error;}
    try{
      if(created){
        assertCreatedTarget(targetName,c.database,created);
        check((await sql`SELECT oid::text AS oid FROM pg_database WHERE datname=${targetName}`.execute(source)).rows[0]?.oid===targetOid,'RESTORE_TARGET_IDENTITY_CHANGED');
        await sql`DROP DATABASE ${sql.id(targetName)} WITH (FORCE)`.execute(source);
        dropped=true;
        if(report)report.targetDropped=true;
      }
    }catch(error){problem=error;}
    try{await source.destroy();}catch(error){problem=error;}
  }
  if(problem){
    await writeFile(join(directory,'failure.json'),JSON.stringify({status:'failed',code:safeDrillCode(problem),backupCreated:!!backup,
      targetDatabase:created?targetName:null,targetDropped:dropped})+'\n',{flag:'wx',mode:0o600});
    throw problem;
  }
  const text=JSON.stringify(report,null,2)+'\n';await writeFile(join(directory,'drill.json'),text,{flag:'wx',mode:0o600});
  return {status:'verified',directory:localPath(directory),reportSha256:hash(text),report};
}
export function safeDrillCode(error){
  const codes=['LOCAL_DATABASE_REQUIRED','UNSAFE_RESTORE_TARGET','POSTGRES_COMMAND_FAILED','POSTGRES_16_REQUIRED','BACKUP_PATH_INVALID',
    'BUNDLE_PATH_INVALID','MODEL_BUNDLE_REQUIRED','ARCHIVE_FORMAT_INVALID','ARCHIVE_SHA_MISMATCH','RESTORED_DATA_MISMATCH',
    'FORECAST_REPLAY_FAILED','REPORT_REPLAY_FAILED','SNAPSHOT_READ_LIMIT','RESTORED_SESSION_REVOCATION_FAILED','RESTORED_DATA_CHANGED','RESTORE_TARGET_IDENTITY_CHANGED'];
  return codes.includes(error?.message)?error.message:'RESTORE_DRILL_FAILED';
}
