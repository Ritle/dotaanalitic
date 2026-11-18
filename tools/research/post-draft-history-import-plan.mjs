import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {resolveIdentity} from '../../packages/db/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const ids=v=>[...new Set(v)].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
const reasons=v=>[...new Set(v)].sort();
const id=v=>v==null||String(v)==='0'?null:String(v);
const pair=(a,b)=>a&&b?ids([a,b]).join(':'):null;
const bestOf=t=>({0:1,1:3,2:5,3:2})[String(t)]??null;
const sourceFact=(p,origin,status='observed')=>({mapId:String(p.match_id),seriesId:id(p.series_id),bestOf:bestOf(p.series_type),
 radiant:id(p.radiant_team_id),dire:id(p.dire_team_id),league:id(p.leagueid),startedAt:p.start_time?new Date(Number(p.start_time)*1000).toISOString():null,
 duration:p.duration??null,winner:typeof p.radiant_win==='boolean'?p.radiant_win:null,origin,status});

export function buildImportPlan(report,proposal,capture){
 const selected=report.rows.filter(r=>r.status==='observed'&&r.assessment?.sourceConsistent&&!r.assessment.coverageReasons.length);
 if(!selected.length||digest(selected.map(r=>r.matchId))!==digest(proposal.priorityMapIds)||digest(capture.selectedMapIds)!==digest(proposal.priorityMapIds))throw Error('priority_scope');
 const allObserved=report.rows.filter(r=>r.status==='observed');
 for(const r of allObserved)if(sha(JSON.stringify(r.receipt.projection))!==r.receipt.projectionSha256||String(r.receipt.projection.match_id)!==r.matchId)throw Error('projection_binding');
 const accounts=ids(selected.flatMap(r=>r.assessment.members.map(m=>m.accountId)));
 if(digest(accounts)!==digest(capture.accounts))throw Error('account_scope');
 const identityRows=accounts.map(accountId=>{
  const resolved=resolveIdentity(capture.identities,accountId,null),why=[];
  if(resolved.status!=='verified')why.push('IDENTITY_'+resolved.status.toUpperCase());
  if(resolved.playerId&&ids(capture.identities.filter(e=>e.playerId===resolved.playerId&&e.status==='verified'&&e.evidenceRef).map(e=>e.externalAccountId)).length!==1)why.push('CROSS_ACCOUNT_UNSUPPORTED');
  const p=capture.players.filter(p=>p.id===resolved.playerId);
  if(resolved.playerId&&(p.length!==1||p[0].opendota_account_id!==accountId||p[0].steam64_id&&p[0].steam64_id!==(76561197960265728n+BigInt(accountId)).toString()))why.push('CANONICAL_NUMERIC_REFERENCE_CONFLICT');
  return {accountId,playerId:resolved.playerId,proofIds:resolved.observationIds,reasons:why,basis:'current_verified_same_account',historicalAvailability:'not_asserted'};
 });
 const facts=allObserved.map(r=>sourceFact(r.receipt.projection,'collection'));
 for(const r of capture.receipts)facts.push({mapId:r.map_id,seriesId:id(r.series_id),bestOf:bestOf(r.series_type),radiant:id(r.radiant),dire:id(r.dire),league:id(r.league),
  startedAt:r.start_time?new Date(Number(r.start_time)*1000).toISOString():null,duration:r.duration==null?null:Number(r.duration),
  winner:r.radiant_win==='true'?true:r.radiant_win==='false'?false:null,origin:'receipt:'+r.id,status:r.status,
  receiptMismatch:r.payload_map_id!==r.map_id||r.canonical_match_id!==null&&r.canonical_match_id!==r.map_id});
 for(const m of capture.maps){const s=capture.series.find(s=>s.id===m.series_id);
  facts.push({mapId:m.id,seriesId:m.provider==='opendota'?m.provider_series_id:null,bestOf:s?.best_of??null,radiant:m.radiant,dire:m.dire,league:m.league,startedAt:m.started_at,
   duration:m.duration_seconds,winner:m.radiant_win,origin:'canonical',status:m.ingest_state});
 }
 const byMap=new Map();for(const f of facts){const list=byMap.get(f.mapId)??[];list.push(f);byMap.set(f.mapId,list);}
 const membership=new Map([...byMap].map(([mapId,fs])=>[mapId,ids(fs.flatMap(f=>f.seriesId?[f.seriesId]:[]))]));
 const dayGroups=new Map();
 for(const f of facts){const teams=pair(f.radiant,f.dire);if(!teams||!f.league||!f.startedAt)continue;
  const key=[f.league,teams,f.startedAt.slice(0,10)].join('|'),group=dayGroups.get(key)??new Set();group.add(f.mapId);dayGroups.set(key,group);
 }
 const reviewGroups=[...dayGroups].flatMap(([key,group])=>{
  const mapIds=ids([...group]),seriesIds=ids(mapIds.flatMap(m=>membership.get(m))),unknown=mapIds.filter(m=>!membership.get(m).length);
  if(mapIds.length<2||!(seriesIds.length>1||unknown.length))return [];
  if(!mapIds.some(m=>proposal.priorityMapIds.includes(m)))return [];
  return [{key,mapIds,sourceSeriesIds:seriesIds,unlinkedMapIds:unknown,reason:unknown.length?'POSSIBLE_UNLINKED_SIBLING':'DISTINCT_SERIES_SAME_DAY_OPPONENTS',automaticMergeAllowed:false}];
 });
 const leagueSnapshot=capture.references.find(r=>r.endpoint==='/leagues'),heroSnapshot=capture.references.find(r=>r.endpoint==='/heroes');
 const registryHeroes=new Set((heroSnapshot?.source_payload??[]).map(h=>h.id));
 const maps=selected.map(r=>{
  const p=r.receipt.projection,why=[],members=r.assessment.members.map(m=>{
   const resolved=identityRows.find(x=>x.accountId===m.accountId);
   if(resolved.reasons.length)why.push(...resolved.reasons);
   if(resolved.playerId!==m.canonicalPlayerId)why.push('IDENTITY_CHANGED_SINCE_COLLECTION');
   return {slot:m.slot,accountId:m.accountId,playerId:resolved.playerId,heroId:m.heroId,proofIds:resolved.proofIds};
  });
  if(members.length!==10||new Set(members.map(m=>m.playerId)).size!==10)why.push('TEN_DISTINCT_CANONICAL_PLAYERS_REQUIRED');
  if(members.some(m=>!registryHeroes.has(m.heroId)))why.push('HERO_REFERENCE_UNRESOLVED');
  if(!members.every(m=>[0,1,2,3,4,128,129,130,131,132].includes(m.slot))||new Set(members.map(m=>m.slot)).size!==10)why.push('NATIVE_SLOTS_REQUIRED');
  const teamActions=['radiant','dire'].map(side=>{
   const externalId=id(p[side+'_team_id']),existing=capture.teams.filter(t=>t.opendota_team_id===externalId),detail=p[side+'_team'];
   if(existing.length>1)why.push('CANONICAL_TEAM_AMBIGUOUS');
   if(!existing.length&&(!detail?.name?.trim()||String(detail.team_id)!==externalId))why.push('TEAM_PROOF_MISSING');
   return {side,externalId,action:existing.length===1?'reuse':'create_from_source',canonicalId:existing.length===1?existing[0].id:null,name:existing.length===1?existing[0].name:detail?.name??null};
  });
  const leagueId=String(p.leagueid),sourceLeagues=(leagueSnapshot?.source_payload??[]).filter(l=>String(l.leagueid)===leagueId),existingLeagues=capture.leagues.filter(l=>l.opendota_league_id===leagueId);
  if(sourceLeagues.length!==1||!['professional','premium'].includes(sourceLeagues[0].tier)||!sourceLeagues[0].name?.trim())why.push('PRO_LEAGUE_REFERENCE_UNRESOLVED');
  if(existingLeagues.length>1||existingLeagues.some(l=>!['professional','premium'].includes(l.tier)))why.push('CANONICAL_LEAGUE_CONFLICT');
  const old=capture.maps.find(m=>m.id===r.matchId);if(old)why.push('MAP_ALREADY_PRESENT_REQUIRES_REVIEW');
  return {matchId:r.matchId,sourceSeriesId:String(p.series_id),reasons:why,members,teamActions,
   leagueAction:{externalId:leagueId,action:existingLeagues.length===1?'reuse':'create_from_cached_catalogue',canonicalId:existingLeagues[0]?.id??null},
   source:{...r.receipt.source},projectionSha256:r.receipt.projectionSha256,
   replay:{adapterVersion:'opendota-projection-replay-v1',payloadSha256:r.receipt.projectionSha256,originalPayloadSha256:r.receipt.source.payloadSha256,originalResponseBytesRetained:false,knownAt:null},
   mapNumber:null,patchId:null,rolePolicy:'not_inferred',trainingEligible:false};
 });
 const groups=ids(maps.map(m=>m.sourceSeriesId)).map(seriesId=>{
  const selectedMaps=maps.filter(m=>m.sourceSeriesId===seriesId),knownMapIds=ids([...byMap].filter(([,fs])=>fs.some(f=>f.seriesId===seriesId)).map(([id])=>id));
  const fs=knownMapIds.flatMap(m=>byMap.get(m)),why=[];
  const types=[...new Set(fs.filter(f=>f.seriesId===seriesId).map(f=>f.bestOf))],pairs=[...new Set(fs.map(f=>pair(f.radiant,f.dire)))],leagues=[...new Set(fs.map(f=>f.league))];
  if(types.length!==1||types[0]===null)why.push('SERIES_TYPE_CONFLICT_OR_UNKNOWN');
  if(pairs.length!==1||pairs[0]===null||leagues.length!==1||leagues[0]===null)why.push('SERIES_REFERENCES_CONFLICT');
  if(types.length===1&&types[0]!==null&&knownMapIds.length>types[0])why.push('SERIES_MAP_COUNT_EXCEEDED');
  if(knownMapIds.some(m=>membership.get(m).length!==1))why.push('MAP_SERIES_CONFLICT');
  if(knownMapIds.some(m=>['radiant','dire','league','startedAt','duration','winner'].some(k=>new Set(byMap.get(m).filter(f=>f[k]!=null).map(f=>f[k])).size>1)))why.push('MAP_FACTS_CONFLICT');
  if(fs.some(f=>['conflict','quarantined'].includes(f.status)||f.receiptMismatch))why.push('KNOWN_SIBLING_SOURCE_CONFLICT');
  if(capture.maps.some(m=>knownMapIds.includes(m.id)&&(m.is_pro!==true||m.ingest_state!=='accepted'||typeof m.radiant_win!=='boolean'||!(m.duration_seconds>0)||
   !(Date.parse(m.started_at)+m.duration_seconds*1000<=Date.parse(capture.capturedAt)))))why.push('KNOWN_SIBLING_OUTCOME_UNVERIFIED');
  if(knownMapIds.some(m=>!proposal.priorityMapIds.includes(m)&&!capture.maps.some(x=>x.id===m&&x.is_pro===true&&x.ingest_state==='accepted')))why.push('SIBLING_OUTSIDE_ELIGIBLE_LOCAL_OR_PLANNED_SET');
  const reviews=reviewGroups.filter(g=>g.mapIds.some(m=>knownMapIds.includes(m)));if(reviews.length)why.push('SERIES_GROUP_REVIEW_REQUIRED');
  const existing=capture.series.filter(s=>s.provider==='opendota'&&s.provider_series_id===seriesId);
  if(existing.length>1||existing.some(s=>pair(s.radiant,s.dire)!==pairs[0]||s.league!==leagues[0]||s.best_of!==types[0]))why.push('CANONICAL_SERIES_CONFLICT');
  for(const m of selectedMaps)why.push(...m.reasons);
  return {sourceSeriesId:seriesId,selectedMapIds:selectedMaps.map(m=>m.matchId),knownMapIds,bestOf:types.length===1?types[0]:null,
   action:existing.length===1?'reuse':'register_after_base_import',canonicalId:existing[0]?.id??null,
   reasons:reasons(why),reviewGroups:reviews,remoteMembershipCompleteness:'unknown',completionStatusNotInferred:true};
 });
 for(const m of maps){m.reasons=reasons([...m.reasons,...groups.find(g=>g.sourceSeriesId===m.sourceSeriesId).reasons]);m.status=m.reasons.length?'excluded_pending_review':'planned_for_isolated_dry_run';}
 const accepted=maps.filter(m=>!m.reasons.length),blocked=maps.filter(m=>m.reasons.length);
 const teamCreates=[...new Map(accepted.flatMap(m=>m.teamActions.filter(t=>t.action==='create_from_source').map(t=>[t.externalId,t]))).values()];
 const result={format:'post-draft-history-import-plan-v1',status:'requires_isolated_dry_run',counts:{selectedMaps:maps.length,accounts:accounts.length,
  verifiedCurrentAccounts:identityRows.filter(i=>!i.reasons.length).length,plannedMaps:accepted.length,excludedMaps:blocked.length,sourceSeries:groups.length,
  plannedSeries:groups.filter(g=>!g.reasons.length).length,newSeries:groups.filter(g=>!g.reasons.length&&g.action==='register_after_base_import').length,newTeams:teamCreates.length},
  identities:identityRows,maps,groups,teamCreates,reviewGroups,
  operationOrder:['validate_input_hashes_and_current_reference_fingerprint','replay_projected_sources_with_distinct_sha_and_preserved_original_provenance','import_base_maps_using_existing_ingestion_service',
   'verify_outcomes','preview_and_register_missing_series','reingest_same_projection_to_resolve_series','verify_outcomes_and_idempotent_replay'],
  requiredBeforeWorkingImport:['isolated_database_dry_run','approved_exact_plan_and_unchanged_inputs','preservation_of_frozen_models_predictions_and_existing_maps'],
  providerHttp:0,businessWrites:0,importedMaps:0,trainingPerformed:false,deployable:false};
 return {...result,fingerprint:digest(result)};
}

async function main(){
 const mode=process.argv[2];if(!['plan','verify'].includes(mode)||process.argv.length!==3)throw Error('arguments');
 const paths={proposal:'docs/evidence/s3-04-history-import-plan-proposal.json',report:'.tools/s304-history-quota-resume-r1/report.json',capture:'.tools/s304-import-plan-capture.json'};
 const s=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await boundedJson(resolve(root,p))])));
 if(s.proposal.value.sourceReportSha256!==s.report.sha256||s.capture.value.sourceReportSha256!==s.report.sha256||s.capture.value.proposalSha256!==s.proposal.sha256)throw Error('source_binding');
 const code=await Promise.all(['tools/research/post-draft-history-import-plan.mjs','tests/node/post-draft-history-import-plan.test.mjs','.tools/s304-import-plan-capture.mjs',
  'packages/db/dist/identity.js','packages/db/dist/identity-repository.js','packages/db/dist/series-provision.js','packages/ingestion/dist/importer.js'].map(async p=>({path:p,sha256:sha(await readFile(resolve(root,p)))})));
 const result={sourceHashes:Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v.sha256])),code,plan:buildImportPlan(s.report.value,s.proposal.value,s.capture.value)};
 const output=resolve(root,'.tools/s304-history-import-plan.json');
 if(mode==='plan')await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 else if(digest(result)!==digest((await boundedJson(output)).value))throw Error('replay_mismatch');
 console.log(JSON.stringify({mode,status:'PASS',counts:result.plan.counts,excluded:result.plan.maps.filter(m=>m.reasons.length).map(m=>({matchId:m.matchId,reasons:m.reasons}))}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('План импорта отклонён: проверьте снимки и контрольные суммы; существующий план не перезаписывается.');process.exitCode=1;});
