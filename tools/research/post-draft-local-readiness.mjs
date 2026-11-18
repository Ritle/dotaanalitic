import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolveIdentity} from '../../packages/db/dist/index.js';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const unique=xs=>[...new Set(xs)].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
const bestOf=t=>({0:1,1:3,2:5,3:2})[String(t)]??null;
const pair=(a,b)=>a&&b?unique([String(a),String(b)]).join(':'):null;
const files={details:'.tools/s304-history-details-r1/report.json',capture:'.tools/s304-local-readiness-capture.json',
 cache:'.tools/s304-local-cache.json',previous:'.tools/v1-retest-import-20261110/identities-01/identity-190100004.json'};
const out='.tools/s304-local-readiness.json';

/** Local prerequisites for verified-history enrichment, not a production import or training gate. */
export function auditLocalReadiness(details,capture,cache,previous=null){
 const selected=details.rows.filter(r=>r.status==='observed'&&r.receipt.basis==='validated_http_projected');
 const ids=selected.map(r=>r.matchId),accounts=unique(selected.flatMap(r=>r.assessment.members.map(p=>p.accountId)));
 if(!ids.length||new Set(ids).size!==ids.length||digest(ids)!==digest(capture.mapIds)||digest(accounts)!==digest(capture.accounts))throw Error('capture_scope');
 const dayGroups=new Map();
 for(const r of selected){const p=r.receipt.projection;
  if(sha(JSON.stringify(p))!==r.receipt.projectionSha256||String(p.match_id)!==r.matchId)throw Error('detail_binding');
  const key=[String(p.leagueid),pair(p.radiant_team_id,p.dire_team_id),new Date(p.start_time*1000).toISOString().slice(0,10)].join('|');
  const group=dayGroups.get(key)??[];group.push(r);dayGroups.set(key,group);
 }
 // A review signal only. Same opponents/day cannot establish a true series.
 const groupingReviews=[...dayGroups.values()].filter(g=>g.length>1&&new Set(g.map(r=>String(r.receipt.projection.series_id))).size>1)
  .map(g=>({mapIds:g.map(r=>r.matchId),providerSeriesIds:unique(g.flatMap(r=>r.receipt.projection.series_id?[String(r.receipt.projection.series_id)]:[])),
   reason:'SAME_DAY_OPPONENTS_DISTINCT_SOURCE_SERIES',automaticMergeAllowed:false}));
 const identityRows=accounts.map(accountId=>{
  const resolution=resolveIdentity(capture.identities,accountId,null),reasons=[];
  if(resolution.status!=='verified')reasons.push('IDENTITY_'+resolution.status.toUpperCase());
  const linked=resolution.playerId?unique(capture.identities.filter(e=>e.playerId===resolution.playerId&&e.status==='verified'&&e.evidenceRef).map(e=>e.externalAccountId)):[];
  if(linked.length>1)reasons.push('CROSS_ACCOUNT_UNSUPPORTED');
  const matchingPlayers=capture.players.filter(p=>p.id===resolution.playerId);
  if(resolution.playerId&&(matchingPlayers.length!==1||matchingPlayers[0].opendota_account_id!==accountId))reasons.push('CANONICAL_NUMERIC_REFERENCE_MISMATCH');
  const cachedProfiles=cache.entries.flatMap(e=>e.status==='observed'?e.matches.filter(p=>p.accountId===accountId).map(p=>({source:e.source,...p})):[]);
  const numericProofCandidates=cachedProfiles.filter(p=>typeof p.steam64==='string'&&/^\d+$/.test(p.steam64)&&BigInt(p.steam64)===76561197960265728n+BigInt(accountId));
  return {accountId,playerId:resolution.playerId,status:reasons.length?'blocked':'verified_current_same_account',reasons,proofIds:resolution.observationIds,
   knownBeforeHistoricalMap:'not_asserted',numericProofCandidates,profileIsNotAutomaticApproval:true,
   legacyRows:capture.legacy.filter(p=>p.external_account_id===accountId).length,
   storedReferenceProfiles:capture.profiles.filter(p=>p.account_id===accountId).length,
   mapIds:selected.filter(r=>r.assessment.members.some(p=>p.accountId===accountId)).map(r=>r.matchId),
   previousCheck:previous?.accountId===accountId?previous:null};
 });
 const maps=selected.map(r=>{
  const p=r.receipt.projection,reasons=[...r.assessment.sourceReasons,...r.assessment.coverageReasons.filter(s=>!s.startsWith('CANONICAL_IDENTITY_'))],seriesId=p.series_id?String(p.series_id):null;
  const players=r.assessment.members.map(m=>identityRows.find(a=>a.accountId===m.accountId));
  if(players.length!==10||players.some(p=>!p||p.status!=='verified_current_same_account')||new Set(players.map(p=>p?.playerId)).size!==10)reasons.push('TEN_VERIFIED_DISTINCT_PLAYERS_REQUIRED');
  const refs={};for(const side of ['radiant','dire']){
   const sourceId=p[side+'_team_id']?String(p[side+'_team_id']):null;
   const matches=capture.teams.filter(t=>t.opendota_team_id===sourceId);refs[side]={sourceId,canonicalId:matches.length===1?matches[0].id:null};
   if(!sourceId||matches.length!==1)reasons.push('TEAM_REFERENCE_'+side.toUpperCase()+'_UNRESOLVED');
  }
  if(!refs.radiant.sourceId||refs.radiant.sourceId===refs.dire.sourceId)reasons.push('TEAM_SIDES_INVALID');
  const leagues=capture.leagues.filter(l=>l.opendota_league_id===String(p.leagueid));
  if(leagues.length!==1||!['professional','premium'].includes(leagues[0].tier))reasons.push('LOCAL_PRO_LEAGUE_UNRESOLVED');
  const series=capture.series.filter(s=>s.provider==='opendota'&&s.provider_series_id===seriesId),expectedBestOf=bestOf(p.series_type);
  if(series.length!==1)reasons.push('CANONICAL_SERIES_UNRESOLVED');
  if(expectedBestOf===null)reasons.push('SERIES_TYPE_UNSUPPORTED');
  if(series.some(s=>pair(s.radiant,s.dire)!==pair(p.radiant_team_id,p.dire_team_id)||s.league!==String(p.leagueid)||s.best_of!==expectedBestOf))reasons.push('CANONICAL_SERIES_CONFLICT');
  const receipts=capture.seriesReceipts.filter(s=>s.series_id===seriesId);
  if(receipts.some(s=>['conflict','quarantined'].includes(s.status)||pair(s.radiant,s.dire)!==pair(p.radiant_team_id,p.dire_team_id)||s.league!==String(p.leagueid)||bestOf(s.series_type)!==expectedBestOf))reasons.push('LOCAL_SERIES_RECEIPT_CONFLICT');
  const existing=capture.maps.filter(m=>m.id===r.matchId);
  if(existing.some(m=>m.provider!=='opendota'||m.provider_series_id!==seriesId))reasons.push('MAP_LINKED_ELSEWHERE');
  const review=groupingReviews.find(g=>g.mapIds.includes(r.matchId));if(review)reasons.push('SERIES_GROUP_REVIEW_REQUIRED');
  return {matchId:r.matchId,localPrerequisitesReady:reasons.length===0,reasons:uniqueReasons(reasons),references:refs,
   leagueId:String(p.leagueid),sourceSeriesId:seriesId,bestOf:expectedBestOf,canonicalSeriesId:series.length===1?series[0].id:null,
   observedMapIdsForSourceSeries:unique([r.matchId,...receipts.map(x=>x.map_id),...capture.maps.filter(m=>m.provider==='opendota'&&m.provider_series_id===seriesId).map(m=>m.id)]),
   remoteMembershipCompleteness:'unknown',mapNumber:null,seriesWinner:null,trainingEligible:false,deployable:false};
 });
 return {format:'post-draft-local-readiness-report-v1',basis:'current_local_evidence_not_historical_availability',accounts:identityRows,maps,groupingReviews,
  counts:{maps:maps.length,accounts:accounts.length,verifiedAccounts:identityRows.filter(r=>r.status==='verified_current_same_account').length,
   blockedAccounts:identityRows.filter(r=>r.status==='blocked').length,localPrerequisitesReady:maps.filter(m=>m.localPrerequisitesReady).length,
   missingTeamIds:unique(maps.flatMap(m=>Object.values(m.references).filter(r=>!r.canonicalId&&r.sourceId).map(r=>r.sourceId))),
   missingLeagueIds:unique(maps.filter(m=>m.reasons.includes('LOCAL_PRO_LEAGUE_UNRESOLVED')).map(m=>m.leagueId)),seriesReviewGroups:groupingReviews.length},
  providerHttp:0,businessWrites:0,importedMaps:0,trainingPerformed:false,deployable:false};
}
const uniqueReasons=v=>[...new Set(v)].sort();

async function main(){
 const mode=process.argv[2];if(!['audit','verify'].includes(mode)||process.argv.length!==3)throw Error('arguments');
 const sources=Object.fromEntries(await Promise.all(Object.entries(files).map(async([k,p])=>[k,await boundedJson(resolve(root,p))])));
 if(sources.capture.value.detailsSha256!==sources.details.sha256||sources.details.sha256!=='4579fc7c44397e7c2a0152153434ead88837134e929c00d1aa54083c2820589a')throw Error('frozen_details_changed');
 const codePaths=['tools/research/post-draft-local-readiness.mjs','tests/node/post-draft-local-readiness.test.mjs','.tools/s304-local-capture.mjs','.tools/s304-local-cache.mjs',
  'packages/db/dist/identity.js','packages/db/dist/identity-repository.js'];
 const code=await Promise.all(codePaths.map(async p=>({path:p,sha256:sha(await readFile(resolve(root,p)))})));
 const result={sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,v.sha256])),code,
  report:auditLocalReadiness(sources.details.value,sources.capture.value,sources.cache.value,sources.previous.value)};
 if(mode==='audit')await writeFile(resolve(root,out),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 else if(digest(result)!==digest((await boundedJson(resolve(root,out))).value))throw Error('replay_mismatch');
 console.log(JSON.stringify({mode,status:'PASS',counts:result.report.counts}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Локальный аудит отклонён: проверьте входные файлы и контрольные суммы; существующий результат не перезаписывается.');process.exitCode=1;});
