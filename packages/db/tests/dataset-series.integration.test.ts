// SYNTHETIC: duplicate provider-series aliases exercise the real importer and PostgreSQL only in a disposable DB.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DatasetBuildRequest } from '@dota/contracts';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { DatasetBuilder } from '../src/dataset-builder.js';
import { GameRegistryRepository, IdentityRepository, MatchContextRepository, sql } from '../src/index.js';
import { IngestionService, OpenDotaClient } from '../../ingestion/src/index.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let builder: DatasetBuilder;
let nextMap=9007199254760000n;
const fetchedAt='2026-10-30T00:00:00.000Z', snapshotAt='2026-10-31T20:00:00.000Z', early='2023-01-01T00:00:00.000Z';
const playerIds=Array.from({length:10},(_,i)=>String(9007199254741001n+BigInt(i)));
const slot=(i:number)=>i<5?i:i+123;
const time=(day:number)=>new Date(Date.UTC(2024,0,day,12)).toISOString();
const request=(day:number,extra:Partial<DatasetBuildRequest>={}):DatasetBuildRequest=>({stage:'pre_match',teamASide:'radiant',
  fromAt:time(day),trainUntil:time(day+1),calibrationUntil:time(day+2),validationUntil:time(day+3),
  toAt:time(day+4),snapshotAt,maxMaps:100,...extra});
beforeAll(async()=>{
  database=await testDatabase();builder=new DatasetBuilder(database.db,{syntheticOnly:true});
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES (11,'Synthetic A',111),(22,'Synthetic B',222),(33,'Synthetic C',333)`.execute(database.db);
  const identity=new IdentityRepository(database.db);
  for(const [i,id] of playerIds.entries()) {
    await sql`INSERT INTO players(id,nickname) VALUES (${id},'Synthetic series player')`.execute(database.db);
    await identity.appendAccountEvidence({playerId:id,externalAccountId:String(100001+i),provider:'opendota',status:'verified',
      eventAt:early,knownAt:early,fetchedAt,source:'synthetic',evidenceRef:'synthetic:account'});
  }
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'synthetic-series',${early})`.execute(database.db);
  await new GameRegistryRepository(database.db).appendPatch({patchId:'1',releasedAt:early,coverageUntil:'2025-01-01T00:00:00.000Z',
    eventAt:early,knownAt:early,fetchedAt,source:'synthetic',evidenceRef:'synthetic:release',reviewState:'accepted'});
},30000);
afterAll(async()=>{await database?.close();},30000);
async function series(providerSeriesId:string,teamBId='22',provider='opendota') {
  return (await sql<{id:string}>`INSERT INTO series(team_a_id,team_b_id,provider,provider_series_id)
    VALUES (11,${teamBId},${provider},${providerSeriesId}) RETURNING id`.execute(database.db)).rows[0]!.id;
}
async function map(day:number,providerSeriesId:string,canonicalSeriesId:string,teamBId='22') {
  const matchId=String(nextMap++), startedAt=time(day);
  let clock=Date.parse(fetchedAt);
  const payload={match_id:matchId,start_time:Date.parse(startedAt)/1000,duration:1800,radiant_win:true,
    radiant_team_id:111,dire_team_id:teamBId==='22'?222:333,leagueid:77,series_id:providerSeriesId,
    players:Array.from({length:10},(_,i)=>({player_slot:slot(i),hero_id:i+1,account_id:100001+i}))};
  const client=new OpenDotaClient({}, {now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async url=>new Response(JSON.stringify(
    url.pathname==='/api/heroes'?Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
      url.pathname==='/api/leagues'?[{leagueid:77,name:'Synthetic pro league',tier:'professional'}]:payload))});
  await new IngestionService(database.db,client).ingest(matchId);
  // Model pre-existing independently resolved canonical aliases without silently merging them.
  await sql`UPDATE matches SET series_id=${canonicalSeriesId},data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  const context=new MatchContextRepository(database.db);
  for(const fact of [{field:'lineup' as const,value:playerIds.map((playerId,i)=>({playerSlot:slot(i),playerId}))},
    {field:'teams' as const,value:{radiantTeamId:'11',direTeamId:teamBId}}])
    await context.append({matchId,fact,eventAt:early,knownAt:early,fetchedAt,availability:'verified_asof',earliestStage:'pre_match',
      provider:'synthetic-archive',providerRecordId:null,evidenceRef:'synthetic:dated-context',adapterVersion:'synthetic-v1',reviewState:'accepted'});
  return matchId;
}

it('does not split one provider series across train/test through two canonical UUIDs',async()=>{
  const first=await series('901'), second=await series('901');
  await map(1,'901',first);await map(4,'901',second);
  const result=await builder.prepare(request(1),'synthetic-series-code',true);
  expect(result).toMatchObject({status:'unavailable',reason:'NO_ELIGIBLE_MAPS',summary:{eligible:0,byReason:{SERIES_CROSSES_SPLIT:2}}});
  expect((await sql<{n:string}>`SELECT count(*) AS n FROM training_dataset_versions`.execute(database.db)).rows[0]!.n).toBe('0');
},30000);

it('loads out-of-window maps belonging to a different canonical alias of the selected provider series',async()=>{
  const first=await series('902'), second=await series('902');
  await map(6,'902',first);await map(10,'902',second);
  const result=await builder.prepare(request(6),'synthetic-series-code',true);
  expect(result).toMatchObject({status:'unavailable',reason:'NO_ELIGIBLE_MAPS',summary:{eligible:0,byReason:{SERIES_OUTSIDE_WINDOW:1}}});
},30000);

it('refuses all aliases with contradictory organizations, including an alias without any local map',async()=>{
  const first=await series('903');await map(11,'903',first);
  const conflicting=await series('903','33');
  const result=await builder.prepare(request(11),'synthetic-series-code',true);
  expect(result).toMatchObject({status:'unavailable',reason:'NO_ELIGIBLE_MAPS',summary:{eligible:0,byReason:{SERIES_ORGANIZATION_CONFLICT:1}}});
  await map(12,'903',conflicting,'33');
  expect(await builder.prepare(request(11),'synthetic-series-code',true))
    .toMatchObject({status:'unavailable',summary:{eligible:0,byReason:{SERIES_ORGANIZATION_CONFLICT:2}}});
},30000);

it('keeps distinct canonical UUIDs in the frozen inventory while grouping a compatible provider series',async()=>{
  const first=await series('904'), second=await series('904');
  const one=await map(16,'904',first), two=await map(17,'904',second);
  const result=await builder.prepare(request(16,{trainUntil:time(18),calibrationUntil:time(19),validationUntil:time(20),toAt:time(21)}),'synthetic-series-code',true);
  expect(result).toMatchObject({status:'frozen',summary:{eligible:2,bySplit:{train:2}}});
  if(result.status!=='frozen') throw new Error('expected_frozen_dataset');
  const {rows}=await sql<{source_manifest:{seriesInventory:{matchId:string;seriesId:string;providerSeriesKey:string;seriesConflict:boolean;
    seriesOrganizationsKnown:boolean}[];seriesAliases:{seriesId:string;providerSeriesKey:string}[]};split_policy:{version:string};cutoff_policy_version:string}>`
    SELECT source_manifest,split_policy,cutoff_policy_version FROM training_dataset_versions WHERE id=${result.datasetId}`.execute(database.db);
  const snapshot=rows[0]!;
  expect(snapshot.cutoff_policy_version).toBe('strict-context-preparation-v2');
  expect(snapshot.split_policy.version).toBe('explicit-windows-provider-series-v2');
  expect(snapshot.source_manifest.seriesInventory).toEqual([
    {matchId:one,seriesId:first,startedAt:time(16),providerSeriesKey:'opendota:904',seriesConflict:false,seriesOrganizationsKnown:true},
    {matchId:two,seriesId:second,startedAt:time(17),providerSeriesKey:'opendota:904',seriesConflict:false,seriesOrganizationsKnown:true}
  ]);
  expect(snapshot.source_manifest.seriesAliases.map(row=>row.seriesId).sort()).toEqual([first,second].sort());
  expect(snapshot.source_manifest.seriesAliases.every(row=>row.providerSeriesKey==='opendota:904')).toBe(true);
  expect((await sql<{n:string}>`SELECT count(*) AS n FROM series WHERE provider='opendota' AND provider_series_id='904'`.execute(database.db)).rows[0]!.n).toBe('2');
},30000);

it('enforces the alias inventory bound without silently dropping a conflicting or distant alias',async()=>{
  const first=await series('905');await map(22,'905',first);await series('905');
  expect(await builder.prepare(request(22,{maxMaps:1}),'synthetic-series-code',true))
    .toMatchObject({status:'unavailable',reason:'SERIES_ALIAS_LIMIT_EXCEEDED',datasetId:null});
},30000);

it('does not merge external ID namespaces across providers',async()=>{
  const first=await series('906');await map(27,'906',first);await series('906','33','stratz');
  const result=await builder.prepare(request(27),'synthetic-series-code',true);
  expect(result).toMatchObject({status:'frozen',summary:{eligible:1}});
  if(result.status!=='frozen') throw new Error('expected_frozen_dataset');
  const content=JSON.parse((await builder.exportFrozen(result.datasetId)).content);
  expect(content.manifest.source_manifest.seriesAliases).toHaveLength(1);
  expect(content.manifest.source_manifest.seriesAliases[0].provider).toBe('opendota');
},30000);

it('later discovery of an alias changes only the next preparation, never old frozen bytes',async()=>{
  const first=await series('907');await map(33,'907',first);
  const frozen=await builder.prepare(request(33),'synthetic-series-code',true);
  expect(frozen.status).toBe('frozen');if(frozen.status!=='frozen') throw new Error('expected_frozen_dataset');
  const before=await builder.exportFrozen(frozen.datasetId);
  const discovered=await series('907');await map(37,'907',discovered);
  expect(await builder.prepare(request(33),'synthetic-series-code',true))
    .toMatchObject({status:'unavailable',summary:{eligible:0,byReason:{SERIES_OUTSIDE_WINDOW:1}}});
  expect(await builder.exportFrozen(frozen.datasetId)).toEqual(before);
},30000);
