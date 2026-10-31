import { createHash } from 'node:crypto';
import { DatasetBuildRequestSchema, CorpusDiscoverySchema as Discovery, CorpusDetailSchema as Detail,
  CorpusShaSchema as Sha, type DatasetBuildRequest } from '@dota/contracts';
import { canonicalContextJson } from './temporal.js';
import { assignDatasetSplits } from './dataset-splits.js';

export type CorpusCapture={kind:'discovery'|'details';sha256:string;content:string};
const hash=(v:unknown)=>createHash('sha256').update(canonicalContextJson(v)).digest('hex');
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const fields=['startedAt','leagueId','providerPatchId','providerSeriesId','radiantTeamId','direTeamId','radiantWon','sourcePro','completed'] as const;
type Field=typeof fields[number];
type Observation={matchId:string;captureSha:string;kind:'discovery'|'details';fetchedAt:string;
  facts:Partial<Record<Field,string|boolean|null>>;flags:Record<string,boolean|null>;reasons:string[]};
const measuredFlags=['confirmed_pro','match_id_consistent','completed_outcome','teams_2','series','identity_10',
  'heroes_10_unique','patch','draft_picks_exact','draft_heroes_match','draft_teams_match','draft_structurally_consistent'];

/** Observational corpus diagnostic only. No raw discovery result becomes a verified label or as-of proof. */
export function auditCorpusCaptures(captures:readonly CorpusCapture[],input:DatasetBuildRequest) {
  const request=DatasetBuildRequestSchema.parse(input), observations:Observation[]=[],sources=[];
  const seenCaptures=new Map<string,CorpusCapture['kind']>();
  let captureErrors=0,duplicateCaptures=0;
  for(const capture of [...captures].sort((a,b)=>compare(a.sha256,b.sha256))) {
    Sha.parse(capture.sha256);
    if(createHash('sha256').update(capture.content,'utf8').digest('hex')!==capture.sha256) throw new Error('capture_sha_mismatch');
    if(seenCaptures.has(capture.sha256)){
      if(seenCaptures.get(capture.sha256)!==capture.kind) throw new Error('conflicting_capture_kind');
      duplicateCaptures++;continue;
    }
    seenCaptures.set(capture.sha256,capture.kind);
    const raw:unknown=JSON.parse(capture.content);
    if(capture.kind==='discovery') {
      const report=Discovery.parse(raw);
      if(report.generated_at>request.snapshotAt || report.selection_catalog.source_evidence.fetched_at>request.snapshotAt)
        throw new Error('capture_after_snapshot');
      sources.push({sha256:capture.sha256,kind:capture.kind,generatedAt:report.generated_at}); captureErrors+=report.errors.length;
      for(const cohort of report.cohorts) {
        if(cohort.source_evidence.fetched_at>request.snapshotAt) throw new Error('capture_after_snapshot');
        const pro=['professional','premium'].includes(cohort.tier??'')?true:['amateur','excluded'].includes(cohort.tier??'')?false:null;
        for(const m of cohort.matches) {
          const startedAt=m.start_time===null?null:new Date(m.start_time*1000).toISOString();
          observations.push({matchId:m.match_id,captureSha:capture.sha256,kind:'discovery',fetchedAt:cohort.source_evidence.fetched_at,
            facts:{startedAt,leagueId:m.leagueid,providerSeriesId:m.series_id,radiantTeamId:m.radiant_team_id,
              direTeamId:m.dire_team_id,radiantWon:m.radiant_win,sourcePro:pro,
              completed:startedAt!==null && m.duration!==null && m.duration>0 && m.radiant_win!==null?
                m.start_time!*1000+m.duration*1000<=Date.parse(cohort.source_evidence.fetched_at):null},
            flags:{},reasons:m.leagueid!==cohort.league_id?['DISCOVERY_LEAGUE_MISMATCH']:[]});
        }
      }
    } else {
      const report=Detail.parse(raw);
      if(report.generated_at>request.snapshotAt || report.source_evidence.some(s=>s.fetched_at>request.snapshotAt)) throw new Error('capture_after_snapshot');
      sources.push({sha256:capture.sha256,kind:capture.kind,generatedAt:report.generated_at});
      if(report.status!=='complete') captureErrors++;
      for(const row of report.observations) {
        if(row.source_evidence===null) throw new Error('detail_source_evidence_missing');
        if(row.source_evidence.fetched_at>request.snapshotAt) throw new Error('capture_after_snapshot');
        observations.push({matchId:row.match_id,captureSha:capture.sha256,kind:'details',fetchedAt:row.source_evidence.fetched_at,
          facts:{startedAt:row.started_at,leagueId:row.league_id,providerPatchId:row.provider_patch_id===null?null:String(row.provider_patch_id),
            sourcePro:row.flags.confirmed_pro??null,completed:row.flags.completed_outcome??null},flags:row.flags,
          reasons:row.flags.match_id_consistent===false?['DETAIL_ID_MISMATCH']:[]});
      }
    }
  }
  if(observations.length>100000) throw new Error('corpus_observation_limit');
  const groups=new Map<string,Observation[]>();
  for(const row of observations) {const list=groups.get(row.matchId)??[];list.push(row);groups.set(row.matchId,list);}
  const maps=[...groups].sort(([a],[b])=>BigInt(a)<BigInt(b)?-1:1).map(([matchId,rows])=>{
    const conflicts:string[]=[],facts:Partial<Record<Field,string|boolean|null>>={};
    for(const field of fields) {
      const values=[...new Set(rows.flatMap(r=>r.facts[field]==null?[]:[r.facts[field]!]))];
      facts[field]=values.length===1?values[0]!:null;
      if(values.length>1) conflicts.push(field);
    }
    const flags=Object.fromEntries(measuredFlags.map(field=>{
      const values=[...new Set(rows.filter(r=>r.kind==='details').flatMap(r=>typeof r.flags[field]==='boolean'?[r.flags[field]!]:[]))];
      if(values.length>1) conflicts.push('flag:'+field);
      return [field,values.length===1?values[0]!:null];
    }));
    return {matchId,facts,flags,conflictFields:conflicts.sort(),reasons:[...new Set(rows.flatMap(r=>r.reasons))].sort(),
      observations:rows.length,detailObservations:rows.filter(r=>r.kind==='details').length,
      sourceHashes:[...new Set(rows.map(r=>r.captureSha))].sort(),
      observedSeriesIds:[...new Set(rows.flatMap(r=>typeof r.facts.providerSeriesId==='string'?[r.facts.providerSeriesId]:[]))].sort()};
  });
  const series=new Map<string,typeof maps>();
  for(const map of maps) for(const id of map.observedSeriesIds) {const list=series.get(id)??[];list.push(map);series.set(id,list);}
  const quarantined=new Set<string>();
  for(const [id,rows] of series) {
    const participants=new Set(rows.flatMap(r=>typeof r.facts.radiantTeamId==='string' && typeof r.facts.direTeamId==='string'?
      [[r.facts.radiantTeamId,r.facts.direTeamId].sort().join(':')]:[]));
    const leagues=new Set(rows.flatMap(r=>typeof r.facts.leagueId==='string'?[r.facts.leagueId]:[]));
    if(participants.size>1 || leagues.size>1 || rows.some(r=>r.conflictFields.length || r.reasons.length || typeof r.facts.startedAt!=='string')) quarantined.add(id);
  }
  const members=maps.filter(r=>typeof r.facts.startedAt==='string').map(r=>({matchId:r.matchId,
    startedAt:r.facts.startedAt as string,seriesId:typeof r.facts.providerSeriesId==='string'?'opendota:'+r.facts.providerSeriesId:null}));
  const assigned=new Map(assignDatasetSplits(members,request).map(r=>[r.matchId,r]));
  const evaluated=maps.map(map=>{
    const {facts}=map,assignment=assigned.get(map.matchId),reasons=[...map.reasons];
    if(map.conflictFields.length) reasons.push('SOURCE_OBSERVATION_CONFLICT');
    if(typeof facts.startedAt!=='string') reasons.push('START_UNKNOWN_OR_CONFLICT');
    else if(!assignment) reasons.push('OUTSIDE_WINDOW');
    if(facts.sourcePro!==true) reasons.push('PRO_CLASSIFICATION_UNCONFIRMED');
    if(facts.completed!==true || typeof facts.radiantWon!=='boolean') reasons.push('DISCOVERY_OUTCOME_UNCONFIRMED');
    if(typeof facts.radiantTeamId!=='string' || typeof facts.direTeamId!=='string' || facts.radiantTeamId===facts.direTeamId) reasons.push('TEAM_SIDES_UNKNOWN');
    if(assignment?.reason) reasons.push(assignment.reason);
    if(map.observedSeriesIds.some(id=>quarantined.has(id))) reasons.push('SERIES_SOURCE_CONFLICT');
    return {...map,discoverySplit:reasons.length?null:assignment?.split??null,reasons:[...new Set(reasons)].sort()};
  });
  const counted=(items:readonly string[])=>Object.fromEntries([...new Set(items)].sort().map(key=>[key,items.filter(v=>v===key).length]));
  const byReason=counted(evaluated.flatMap(r=>r.reasons));
  const coverage=(rows:typeof evaluated)=>Object.fromEntries(measuredFlags.map(field=>{
    const assessed=rows.filter(r=>typeof r.flags[field]==='boolean'),passed=assessed.filter(r=>r.flags[field]===true).length;
    return [field,{passed,assessed:assessed.length,unassessed:rows.length-assessed.length,ratio:assessed.length?passed/assessed.length:null}];
  }));
  const detailed=evaluated.filter(r=>r.detailObservations>0);
  const strata=(field:Field|'year')=>{
    const key=(row:typeof evaluated[number])=>field==='year'?(typeof row.facts.startedAt==='string'?row.facts.startedAt.slice(0,4):'unknown'):String(row.facts[field]??'unknown');
    return [...new Set(evaluated.map(key))].sort().map(value=>{
      const rows=evaluated.filter(row=>key(row)===value),details=rows.filter(r=>r.detailObservations>0);
      return {value,maps:rows.length,detailedMaps:details.length,discoveryAssigned:rows.filter(r=>r.discoverySplit!==null).length,
        conflicts:rows.filter(r=>r.conflictFields.length>0).length,detailCoverage:coverage(details)};
    });
  };
  const body={policyVersion:'provider-corpus-diagnostic-v1',scope:'retrospective_source_discovery',request,sources,
    status:evaluated.length===0?'unavailable':captureErrors?'partial':'diagnostic_complete',captureErrors,duplicateCaptures,
    observations:observations.length,uniqueMaps:evaluated.length,repeatedObservations:observations.length-evaluated.length,
    discoveryMaps:maps.filter(m=>groups.get(m.matchId)!.some(r=>r.kind==='discovery')).length,detailedMaps:detailed.length,
    conflictingMaps:evaluated.filter(r=>r.conflictFields.length>0).length,knownSourceSeries:series.size,
    quarantinedSourceSeries:[...quarantined].sort(),byReason,detailCoverage:coverage(detailed),
    bySplit:counted(evaluated.flatMap(r=>r.discoverySplit??[])),strata:{league:strata('leagueId'),providerPatch:strata('providerPatchId'),year:strata('year')},
    maps:evaluated,remoteCorpusCompleteness:'unknown',seriesMembershipCompleteness:'unknown',
    strictHistoricalEligibility:'not_assessed',trainingReady:false,deployable:false,
    blockers:['CANONICAL_VERIFIED_DATASET_REQUIRED','HISTORICAL_LINEUP_PATCH_DRAFT_PROOFS_REQUIRED','CORPUS_COMPLETENESS_UNPROVEN']};
  return {...body,fingerprint:hash(body)};
}
