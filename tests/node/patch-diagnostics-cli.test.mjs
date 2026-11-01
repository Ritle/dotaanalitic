// SYNTHETIC isolated CLI fixtures only, never production model inputs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,unlink,rmdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url)),script=join(root,'scripts/diagnose-corpus-patches.mjs');
async function workspace(work){
  const dir=await mkdtemp(join(tmpdir(),'dota-patch-diagnostics-')),names=new Set();
  const path=name=>{assert.match(name,/^[a-z-]+\.json$/);names.add(name);return join(dir,name);};
  try{
    const source={endpoint:'/matches/9007199254740993',fetched_at:'2025-01-01T00:00:00.000Z',payload_sha256:'a'.repeat(64),adapter_version:'synthetic-patch-cli'};
    const save=async(name,data)=>{const content=JSON.stringify(data)+'\n';await writeFile(path(name),content);return {path:name,sha256:createHash('sha256').update(content).digest('hex')};};
    const maps=await save('maps.json',{schema_version:3,mode:'live_opendota',status:'complete',generated_at:'2025-01-02T00:00:00.000Z',source_evidence:[source],observations:[{
      match_id:'9007199254740993',started_at:'2024-10-01T00:00:00.000Z',league_id:'1',provider_patch_id:0,flags:{confirmed_pro:true},source_evidence:source}]});
    const provider=await save('provider.json',[{id:0,name:'7.41',date:'2024-01-01T00:00:00.000Z'}]);
    const valve=await save('valve.json',{data:{success:true,patches:[{patch_number:'7.41f',patch_timestamp:1725148800}]},source:{
      url:'https://www.dota2.com/datafeed/patchnoteslist?language=english',adapterVersion:'valve-patch-audit-v1',fetchedAt:source.fetched_at,knownAt:null,payloadSha256:'b'.repeat(64),attempts:1}});
    const revision='a'.repeat(40),config={schemaVersion:1,snapshotAt:'2025-02-01T00:00:00.000Z',mapCaptures:[maps],providerPatches:{...provider,revision,
      sourceUrl:`https://raw.githubusercontent.com/odota/dotaconstants/${revision}/build/patch.json`,fetchedAt:source.fetched_at},valveList:valve};
    const invoke=async(name='report.json')=>{
      await writeFile(path('config.json'),JSON.stringify(config));
      const r=spawnSync(process.execPath,[script,path('config.json'),path(name)],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true,
        env:{...process.env,DATABASE_URL:'invalid-offline-sentinel',OPENDOTA_API_KEY:'secret-offline-sentinel'}});
      assert.equal(r.error,undefined);assert.ok(!(r.stdout+r.stderr).includes('secret-offline-sentinel'));return r;
    };
    await work({path,config,invoke});
  }finally{for(const name of names)await unlink(join(dir,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(dir);}
}
test('CLI is deterministic, offline and preserves bigint map IDs',()=>workspace(async({path,invoke})=>{
  assert.equal((await invoke()).status,0);assert.equal((await invoke('replay.json')).status,0);
  const bytes=await readFile(path('report.json'));assert.deepEqual(await readFile(path('replay.json')),bytes);
  const r=JSON.parse(bytes);assert.equal(r.maps[0].matchId,'9007199254740993');assert.equal(r.maps[0].verifiedPatchId,null);assert.equal(r.databaseWrites,0);
}));
test('CLI refuses to overwrite a previous report',()=>workspace(async({path,invoke})=>{
  assert.equal((await invoke()).status,0);const before=await readFile(path('report.json'));
  const r=await invoke();assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).code,'OUTPUT_EXISTS');assert.deepEqual(await readFile(path('report.json')),before);
}));
test('tampered bytes fail before creating output and do not expose payloads',()=>workspace(async({path,invoke})=>{
  await writeFile(path('maps.json'),'secret-offline-sentinel');const r=await invoke();assert.equal(r.status,1);
  assert.equal(JSON.parse(r.stderr).code,'SNAPSHOT_SHA_MISMATCH');await assert.rejects(access(path('report.json')));
}));
test('oversize source files and future snapshots fail closed',()=>workspace(async({path,config,invoke})=>{
  config.providerPatches.fetchedAt='2026-01-01T00:00:00.000Z';const r=await invoke();assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).code,'SOURCE_AFTER_SNAPSHOT');
  await writeFile(path('maps.json'),' '.repeat(8*1024*1024+1));const large=await invoke();assert.equal(large.status,1);assert.equal(JSON.parse(large.stderr).code,'INPUT_SIZE_LIMIT');
  await assert.rejects(access(path('report.json')));
}));
