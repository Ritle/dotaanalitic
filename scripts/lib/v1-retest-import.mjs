import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {RetestImportConfigSchema,RetestImportManifestSchema} from '../../packages/contracts/dist/v1-retest-import.js';
import {HeroesSchema,LeaguesSchema} from '../../packages/ingestion/dist/opendota/schemas.js';
import {parseSource,classifyLeague} from '../../packages/ingestion/dist/quality.js';
import {withRetestStore,readRetestState} from './v1-retest-store.mjs';
import {collectionInventory,decodeHistoricalHistory} from './v1-retest-collection.mjs';
import {referenceObservation,numericImportReviews,historicalImportProvider,reconcileHistoricalImport} from './v1-historical-import.mjs';
import {hash,order} from './v1-historical-collection.mjs';
import {bounded,save,sha} from './v1-historical-protocol.mjs';
export const fail=code=>{throw Error('retest_import_'+code);};
const stamp=body=>({...body,fingerprint:hash(body)}),same=(a,b)=>hash(a)===hash(b);
const groups=['admissions','outcomes','cached','runs','recoveries'];
/** Cheap refusal for an open collection. Never creates a closure, reads a DB, or calls a provider. */
export async function closedRetestHeader(directory,digest){
 const root=resolve(directory),stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())fail('directory');
 const header=(await bounded(join(root,'collection.json'),65536,digest)).data,{fingerprint,...body}=header;
 if(header.format!=='retest-source-collection-v2'||header.schemaVersion!==2||hash(body)!==fingerprint)fail('collection_format');
 let closure;try{closure=await lstat(join(root,'closure.json'));}catch(e){if(e.code==='ENOENT')fail('collection_not_closed');throw e;}
 if(!closure.isFile()||closure.isSymbolicLink())fail('closure_file');
 return root;
}
export async function retestSourceManifest(ctx,state){
 if(!state.closure)fail('collection_not_closed');
 const files=[];
 for(const directory of groups)for(const name of (await readdir(join(ctx.root,directory))).sort()){
  if(!/^[a-z0-9.-]+\.json$/.test(name))fail('source_inventory');
  const path=join(ctx.root,directory,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink())fail('source_file');
  files.push({directory,name,sha256:sha(await readFile(path))});
 }
 return RetestImportManifestSchema.parse(stamp({schemaVersion:2,format:'retest-import-sources-v2',collectionSha256:ctx.storeSha,
  closureSha256:sha(await readFile(join(ctx.root,'closure.json'))),configSha256:ctx.configSha,
  protocolFingerprint:ctx.plan.fingerprint,stateFingerprint:state.closure.stateFingerprint,files}));
}
export async function createRetestImportManifest(directory,digest){
 const root=await closedRetestHeader(directory,digest);
 return withRetestStore(root,digest,async ctx=>{
  if(ctx.config.syntheticOnly)fail('synthetic_collection');return retestSourceManifest(ctx,await readRetestState(ctx));
 });
}
/** Pure preparation after store verification; no network, model scoring or canonical writes. */
export function buildRetestImport(configRef,ctx,state,sources,manifest,reviewedAt){
 if(!state.closure||state.closure.closedAt>reviewedAt)fail('collection_not_closed');
 if(ctx.config.syntheticOnly||ctx.plan.syntheticOnly)fail('synthetic_collection');
 const report=state.closure.report;
 if(report.format!=='retest-collection-review-v2'||!report.collection.terminal||report.protocolFingerprint!==ctx.plan.fingerprint)fail('closure_binding');
 const {heroes,leagues,registry,profiles}=sources;
 const maps=[...state.records].filter(([k])=>k.startsWith('map-')).map(([key,r])=>{
  const matchId=key.slice(4),parsed=parseSource(r.observation,matchId),found=leagues.data.filter(l=>l.leagueid===parsed.match?.leagueid);
  const reasons=[...parsed.issues];if(found.length!==1||classifyLeague(found[0]?.tier)!==true)reasons.push('PRO_STATUS_UNVERIFIED');
  return {matchId,observation:r.observation,map:parsed.match,reasons,sourceFingerprint:r.fingerprint};
 }).sort((a,b)=>order(a.matchId,b.matchId));
 const inventory=collectionInventory(ctx,state,state.closure.closedAt),conflicts=new Set();
 for(const job of inventory.jobs??[]){const record=state.records.get(job.key);if(!record)continue;
  for(const row of decodeHistoricalHistory(job,record.observation,state.closure.closedAt).rows){
   const m=maps.find(m=>m.matchId===row.match_id)?.map;if(!m)continue;
   if(row.leagueid!==m.leagueid||row.start_time!==m.start_time||row.duration!==m.duration||row.radiant_win!==m.radiant_win||
    !m.players?.some(p=>p.account_id===row.account_id&&p.player_slot===row.player_slot))conflicts.add(row.match_id);
  }
 }
 for(const m of maps)if(conflicts.has(m.matchId))m.reasons.push('HISTORY_DISCOVERY_CONFLICT');
 const accounts=[...new Set(maps.filter(m=>!m.reasons.length).flatMap(m=>(m.map.players??[]).flatMap(p=>p.account_id&&BigInt(p.account_id)<4294967295n?[p.account_id]:[])))].sort(order);
 const identities=numericImportReviews(registry,profiles,accounts,reviewedAt);
 const plan=stamp({schemaVersion:2,format:'v1-retest-import-plan-v2',config:configRef,reviewedAt,
  protocolFingerprint:ctx.plan.fingerprint,closureSha256:manifest.closureSha256,closureFingerprint:state.closure.fingerprint,
  sourceManifestFingerprint:manifest.fingerprint,canonicalBase:ctx.config.canonicalHistory,collectionReport:report,
  maps:maps.map(m=>({matchId:m.matchId,payloadSha256:m.observation.source.payloadSha256,observationFingerprint:hash(m.observation),sourceFingerprint:m.sourceFingerprint,reasons:m.reasons})),
  historyConflictMapIds:[...conflicts].sort(order),accounts,identityReviews:identities.reviews,unresolvedProfiles:identities.rejected,
  canonicalBaseIds:ctx.canonical.source.candidates.map(m=>m.matchId).sort(order),syntheticOnly:false,
  historyWindow:{fromAt:ctx.canonical.source.request.fromAt,toAt:ctx.canonical.source.request.toAt,maxMaps:ctx.canonical.source.request.maxMaps},
  providerSeriesIds:[...new Set(maps.filter(m=>!m.reasons.length).flatMap(m=>m.map.series_id??[]))].sort(order),
  importPolicy:'closed-retest-existing-canonical-importer-v2',providerRequests:0,evaluationPerformed:false,deployable:false});
 return {plan,ctx,maps,heroes,leagues};
}
export async function retestImportInputs(configPath,digest,reviewedAt=new Date().toISOString()){
 if(new Date(reviewedAt).toISOString()!==reviewedAt||reviewedAt>new Date().toISOString())fail('clock');
 const config=RetestImportConfigSchema.parse((await bounded(configPath,262144,digest)).data);
 const root=await closedRetestHeader(config.collection.directory,config.collection.sha256);
 return withRetestStore(root,config.collection.sha256,async ctx=>{
  if(ctx.config.syntheticOnly)fail('synthetic_collection');const state=await readRetestState(ctx);
  const manifest=RetestImportManifestSchema.parse((await bounded(config.sourceManifest.path,16777216,config.sourceManifest.sha256)).data);
  if(!same(manifest,await retestSourceManifest(ctx,state)))fail('source_manifest_binding');
  const heroes=referenceObservation((await bounded(config.heroes.path,16777216,config.heroes.sha256)).data,'/heroes',HeroesSchema,reviewedAt);
  const leagues=referenceObservation(ctx.inputs.catalogue,'/leagues',LeaguesSchema,reviewedAt);
  const registry=(await bounded(config.registry.path,16777216,config.registry.sha256)).data;
  const profiles=[];for(const p of config.profiles)profiles.push({...p,observation:(await bounded(p.path,2097152,p.sha256)).data});
  return buildRetestImport({path:configPath,sha256:digest},ctx,state,{heroes,leagues,registry,profiles},manifest,reviewedAt);
 });
}
export async function readRetestImportPlan(path,digest){
 const saved=(await bounded(path,16777216,digest)).data;
 if(saved?.schemaVersion!==2||saved.format!=='v1-retest-import-plan-v2')fail('plan_format');
 const inputs=await retestImportInputs(saved.config?.path,saved.config?.sha256,saved.reviewedAt);
 if(!same(saved,inputs.plan))fail('plan_replay');return inputs;
}
export function reconcileRetestImport(plan,dataset){
 if(plan.format!=='v1-retest-import-plan-v2'||plan.schemaVersion!==2||plan.syntheticOnly)fail('plan_format');
 if(dataset.source?.candidates.some(m=>plan.historyConflictMapIds.includes(m.matchId)))fail('history_discovery_conflict');
 const report=reconcileHistoricalImport(plan,dataset);
 return {...report,schemaVersion:2,format:'v1-retest-canonical-review-v2',closureSha256:plan.closureSha256,
  sourceManifestFingerprint:plan.sourceManifestFingerprint,collectionUnavailableSources:plan.collectionReport.unavailableSources};
}
export {historicalImportProvider as retestImportProvider,save,sha};
