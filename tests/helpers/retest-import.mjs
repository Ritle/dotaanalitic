// Synthetic provider observations only; this helper is never used outside disposable tests.
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import assert from 'node:assert/strict';
import {prepareV1Data} from '../../packages/db/dist/v1-data.js';
import {playerHistoryQuery} from '../../packages/ingestion/dist/player-history.js';
import {captureRetestBatch,readRetestState} from '../../scripts/lib/v1-retest-store.mjs';
import {retestSourceManifest,buildRetestImport,sha} from '../../scripts/lib/v1-retest-import.mjs';
import {referenceObservation} from '../../scripts/lib/v1-historical-import.mjs';
import {HeroesSchema,LeaguesSchema} from '../../packages/ingestion/dist/opendota/schemas.js';
import {hash} from '../../scripts/lib/v1-historical-collection.mjs';
export async function retestImportFixture(n=2){
 const root=await mkdtemp(join(tmpdir(),'retest-import-test-'));for(const d of ['admissions','outcomes','cached','runs','recoveries'])await mkdir(join(root,d));
 const at='2026-11-06T12:00:00.000Z';let clock=at;const stamp=v=>({...v,fingerprint:hash(v)});
 const obs=(endpoint,raw)=>({source:{provider:'opendota',adapterVersion:'opendota-synthetic-import-test-v1',endpoint,
  fetchedAt:clock,knownAt:null,payloadSha256:sha(JSON.stringify(raw))},rawBody:JSON.stringify(raw)});
 const map=(id,i)=>({match_id:id,series_id:'700',series_type:1,start_time:Date.parse('2026-02-10T00:00:00.000Z')/1000+i*7200,
  duration:1800,radiant_win:true,leagueid:'100',radiant_team_id:i%2?'2':'1',dire_team_id:i%2?'1':'2',lobby_type:1,
  radiant_team:{team_id:i%2?'2':'1',name:i%2?'Synthetic two':'Synthetic one'},dire_team:{team_id:i%2?'1':'2',name:i%2?'Synthetic one':'Synthetic two'},
  players:Array.from({length:10},(_,j)=>({player_slot:j<5?j:j+123,hero_id:j+1,account_id:String(100+(i%2?(j+5)%10:j))}))});
 const source={request:{schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',fromAt:'2024-01-01T00:00:00.000Z',toAt:'2026-11-01T00:00:00.000Z',snapshotAt:at,maxMaps:5000},
  identityRevision:'1',candidates:[],aliases:[],identities:[],code:[{path:'synthetic-test.js',sha256:'a'.repeat(64)}],syntheticOnly:true};
 const ctx={root,now:()=>clock,configSha:'b'.repeat(64),config:{syntheticOnly:false,maxRequestsPerRun:50,maxHistoryHttpAttempts:3,
  canonicalHistory:{path:'synthetic-base.json',sha256:'a'.repeat(64)},historyPolicy:{windowDays:730,maxMapsPerAccount:10}},
  store:{createdAt:at},plan:{syntheticOnly:false,fingerprint:'c'.repeat(64),request:{maxInventoryMaps:5000,warmupFromAt:'2024-01-01T00:00:00.000Z',events:[{fromAt:'2026-02-01T00:00:00.000Z'}]},collection:{maxDetailAttemptsPerMap:3,collectionDeadline:'2026-11-13T00:00:00.000Z'}},
  review:{ledger:[]},catalogue:[{leagueid:'100',name:'Synthetic league',tier:'professional'}],exposure:{blockedMatchIds:[],opendotaSeriesIds:[]},canonical:prepareV1Data(source),cache:{matches:[]}};
 const rawMaps=Array.from({length:n},(_,i)=>map(String(100000001+i),i));
 for(const m of rawMaps)ctx.review.ledger.push({matchId:m.match_id,leagueId:m.leagueid,providerSeriesId:m.series_id,startTime:m.start_time,radiantTeamId:m.radiant_team_id,direTeamId:m.dire_team_id,inTargetWindow:true,exposureExcluded:false,reasons:[]});
 const header=stamp({schemaVersion:2,format:'retest-source-collection-v2',createdAt:at,configPath:join(root,'synthetic-only.json'),configSha256:ctx.configSha,protocolFingerprint:ctx.plan.fingerprint});
 const bytes=JSON.stringify(header)+'\n';await writeFile(join(root,'collection.json'),bytes);ctx.storeSha=sha(bytes);
 const provider=async(limit,hooks)=>{const fetch=async(endpoint,raw)=>{hooks.guard();await hooks.beforeRequest();await hooks.observe(200,null);return obs(endpoint,raw);};
  return {client:{getMatchSource:id=>fetch('/matches/'+id,rawMaps.find(m=>m.match_id===id))},
   discover:(...args)=>fetch('/explorer?'+new URLSearchParams({sql:playerHistoryQuery(...args)}),{err:null,rows:[]}),close:async()=>{}};};
 const sources={heroes:referenceObservation(obs('/heroes',Array.from({length:10},(_,i)=>({id:i+1,name:`npc_dota_hero_synthetic_${i}`,localized_name:`Synthetic ${i}`}))),'/heroes',HeroesSchema,at),
  leagues:referenceObservation(obs('/leagues',ctx.catalogue),'/leagues',LeaguesSchema,at),profiles:[],
  registry:obs('/proPlayers',Array.from({length:10},(_,i)=>({account_id:String(100+i),steamid:String(76561197960265728n+BigInt(100+i)),name:'Synthetic same alias'})))};
 return {root,ctx,rawMaps,obs,sources,at,provider,setTime:value=>{clock=value;},
  close:async()=>{await captureRetestBatch(ctx,'targets',provider);await captureRetestBatch(ctx,'history',provider);return readRetestState(ctx);},
  prepare:async()=>{const state=await readRetestState(ctx),manifest=await retestSourceManifest(ctx,state);
   return buildRetestImport({path:'synthetic-config.json',sha256:'d'.repeat(64)},ctx,state,sources,manifest,clock);},
  dispose:async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('retest-import-test-'));await rm(root,{recursive:true,force:true});}};
}
