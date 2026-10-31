// SYNTHETIC: isolated PostgreSQL, real importer and frozen preparation boundary.
import { afterAll,beforeAll,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rmdir,unlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { GameRegistryRepository,IdentityRepository,MatchContextRepository,sql } from '../src/index.js';
import { DatasetBuilder } from '../src/dataset-builder.js';
import { DatasetAuditRepository,auditFrozenDatasetContent } from '../src/dataset-audit.js';
import { OpenDotaClient,IngestionService } from '../../ingestion/src/index.js';
import type { ContextFact,DatasetBuildRequest } from '@dota/contracts';

let database:Awaited<ReturnType<typeof testDatabase>>;
let datasetId:string;
const early='2023-01-01T00:00:00.000Z',fetchedAt='2026-10-30T00:00:00.000Z';
const ids=Array.from({length:10},(_,i)=>String(9007199254741001n+BigInt(i)));
const slot=(i:number)=>i<5?i:i+123;
const time=(day:number)=>new Date(Date.UTC(2024,0,day)).toISOString();
const request:DatasetBuildRequest={stage:'pre_match',teamASide:'radiant',fromAt:time(1),trainUntil:time(5),
  calibrationUntil:time(10),validationUntil:time(15),toAt:time(20),snapshotAt:'2026-10-31T20:00:00.000Z',maxMaps:100};
beforeAll(async()=>{
  database=await testDatabase();
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES (11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
  for(const [i,id] of ids.entries()){
    await sql`INSERT INTO players(id,nickname) VALUES (${id},'Synthetic audit player')`.execute(database.db);
    await new IdentityRepository(database.db).appendAccountEvidence({playerId:id,externalAccountId:String(100001+i),
      provider:'opendota',status:'verified',eventAt:early,knownAt:early,fetchedAt,source:'synthetic',evidenceRef:'synthetic:identity'});
  }
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'Synthetic audit patch',${early})`.execute(database.db);
  await new GameRegistryRepository(database.db).appendPatch({patchId:'1',releasedAt:early,
    coverageUntil:'2025-01-01T00:00:00.000Z',eventAt:early,knownAt:early,fetchedAt,source:'synthetic',
    evidenceRef:'synthetic:release',reviewState:'accepted'});
  for(const [i,day] of [2,6,11,16].entries()){
    const matchId=String(9007199254759000n+BigInt(i)),seriesId=String(500+i);
    await sql`INSERT INTO series(team_a_id,team_b_id,provider,provider_series_id) VALUES (11,22,'opendota',${seriesId})`.execute(database.db);
    const payload={match_id:matchId,start_time:Date.parse(time(day))/1000,duration:1800,radiant_win:i%2===0,
      radiant_team_id:111,dire_team_id:222,leagueid:77,series_id:seriesId,
      players:ids.map((_,n)=>({player_slot:slot(n),account_id:100001+n,hero_id:n+1}))};
    let clock=Date.parse(fetchedAt);
    const client=new OpenDotaClient({}, {now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async url=>new Response(JSON.stringify(
      url.pathname==='/api/heroes'?ids.map((_,n)=>({id:n+1,name:`synthetic_${n}`,localized_name:`Synthetic ${n}`})):
      url.pathname==='/api/leagues'?[{leagueid:77,name:'Synthetic pro league',tier:'professional'}]:payload))});
    await new IngestionService(database.db,client).ingest(matchId);
    const facts:ContextFact[]=[{field:'teams',value:{radiantTeamId:'11',direTeamId:'22'}},
      {field:'lineup',value:ids.map((playerId,n)=>({playerSlot:slot(n),playerId}))}];
    for(const fact of facts)await new MatchContextRepository(database.db).append({matchId,fact,eventAt:early,knownAt:early,
      fetchedAt,availability:'verified_asof',earliestStage:'pre_match',provider:'synthetic',providerRecordId:null,
      evidenceRef:'synthetic:announcement',adapterVersion:'synthetic-v1',reviewState:'accepted'});
  }
  const frozen=await new DatasetBuilder(database.db,{syntheticOnly:true}).prepare(request,'synthetic-audit-code',true);
  if(frozen.status!=='frozen')throw new Error(JSON.stringify(frozen));datasetId=frozen.datasetId;
},30000);
afterAll(async()=>{await database?.close();},30000);

it('audits actual PostgreSQL canonical bytes of a four-fold frozen preparation',async()=>{
  const result=await new DatasetAuditRepository(database.db).audit(datasetId);
  expect(result).toMatchObject({datasetId,status:'valid',structuralChecksPassed:true,trainingReady:false,
    deployable:false,summary:{maps:4,syntheticOnly:true,byPatch:{'1':4}}});
  expect(result.reasons).toEqual([]);
  const exported=await new DatasetBuilder(database.db).exportFrozen(datasetId);
  expect(result.fingerprint).toBe(exported.fingerprint);
  expect(createHash('sha256').update(exported.content).digest('hex')).toBe(result.fingerprint);
},30000);

it('does not consult corrected current maps or mutate a saved dataset while auditing',async()=>{
  const audit=new DatasetAuditRepository(database.db),before=await audit.audit(datasetId);
  const exported=await new DatasetBuilder(database.db).exportFrozen(datasetId);
  await sql`UPDATE matches SET radiant_win=NOT radiant_win,data_revision=data_revision+1`.execute(database.db);
  expect(await audit.audit(datasetId)).toEqual(before);
  expect(await new DatasetBuilder(database.db).exportFrozen(datasetId)).toEqual(exported);
  const counts=(await sql<{n:string}>`SELECT count(*) AS n FROM training_dataset_versions`.execute(database.db)).rows[0]!;
  expect(counts.n).toBe('1');
},30000);

it('rejects modified export content and leaves absent or non-frozen IDs unavailable',async()=>{
  const exported=await new DatasetBuilder(database.db).exportFrozen(datasetId);
  expect(auditFrozenDatasetContent(exported.content+' ',exported.fingerprint)).toMatchObject({status:'invalid',
    reasons:['DATASET_FINGERPRINT_MISMATCH']});
  expect(await new DatasetAuditRepository(database.db).audit('123e4567-e89b-42d3-a456-426614174000'))
    .toMatchObject({status:'unavailable',reasons:['FROZEN_DATASET_NOT_FOUND'],trainingReady:false});
},30000);

it('CLI audits stored and exported snapshots without changing their bytes or adding dataset rows',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'dota-synthetic-dataset-audit-')),path=join(directory,'export.json');
  const script=fileURLToPath(new URL('../../../scripts/audit-dataset.mjs',import.meta.url));
  const cli=(...args:string[])=>spawnSync(process.execPath,[script,...args],{
    env:{...process.env,DATABASE_URL:database.url},encoding:'utf8',windowsHide:true,timeout:15000});
  const exported=await new DatasetBuilder(database.db).exportFrozen(datasetId);
  try{
    await writeFile(path,exported.content,'utf8');
    for(const args of [['stored',datasetId],['file',path,exported.fingerprint]]){
      const response=cli(...args);expect(response.error).toBeUndefined();expect(response.status).toBe(0);
      expect(JSON.parse(response.stdout)).toMatchObject({status:'valid',fingerprint:exported.fingerprint,trainingReady:false});
    }
    const absent=cli('stored','123e4567-e89b-42d3-a456-426614174000');expect(absent.status).toBe(3);
    expect(JSON.parse(absent.stdout).reasons).toEqual(['FROZEN_DATASET_NOT_FOUND']);
    const mismatch=cli('file',path,'0'.repeat(64));expect(mismatch.status).toBe(1);
    expect(JSON.parse(mismatch.stdout).reasons).toEqual(['DATASET_FINGERPRINT_MISMATCH']);
    expect(await readFile(path,'utf8')).toBe(exported.content);
    expect((await sql<{n:string}>`SELECT count(*) AS n FROM training_dataset_versions`.execute(database.db)).rows[0]!.n).toBe('1');
  }finally{await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(directory);}
},30000);
