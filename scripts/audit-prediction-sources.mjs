#!/usr/bin/env node
/** Bounded source coverage audit; shared durable quotas, no canonical imports or model output. */
import {readFile,mkdir,writeFile,open} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonicalId,inspectMatch} from './lib/match-quality.mjs';
import {selectAuditMaps,safeAuditError,buildAuditReport} from './lib/coverage-audit.mjs';
const argv=process.argv.slice(2);
function arg(name,fallback){const i=argv.indexOf(name);return i===-1?fallback:argv[i+1];}
const fixture=arg('--fixture',null),sample=Number(arg('--sample',20)),output=arg('--out',null),leagueId=arg('--league',null);
const teamText=arg('--teams',null),captureFile=arg('--capture',null),teamIds=teamText?.split(',')??null;
if(!Number.isInteger(sample)||sample<1||sample>50||leagueId!==null&&canonicalId(leagueId)===null||
  teamIds&&(fixture||leagueId||!output||!captureFile||teamIds.length>5||new Set(teamIds).size!==teamIds.length||teamIds.some(id=>canonicalId(id)===null))||captureFile&&!teamIds){
  console.error('--sample 1..50; --league ID or --teams ID,ID --capture FILE --out FILE (live only)');process.exit(2);
}
let runtime,currentHistory,captureRef;
let captureOutput,reportOutput;
if(teamIds){
  try{
    const root=fileURLToPath(new URL('../',import.meta.url));
    for(const file of [captureFile,output]){const rel=relative(root,resolve(file));
      if(!rel||rel.startsWith('..')||isAbsolute(rel)||!rel.endsWith('.json'))throw new Error('path');await mkdir(dirname(file),{recursive:true});}
    captureOutput=await open(captureFile,'wx');reportOutput=await open(output,'wx');
  }catch{await captureOutput?.close();await reportOutput?.close();console.error('Нужны новые JSON-файлы capture и отчёта внутри проекта.');process.exit(2);}
}
const rows=[],errors=[],sourceEvidence=[];
let selection={selected:[],candidates:0,duplicates:0,invalid:0,outsideCohort:0,method:'discovery_unavailable'};
const evidence=source=>({endpoint:source.endpoint,fetched_at:source.fetchedAt,payload_sha256:source.payloadSha256,
  adapter_version:source.adapterVersion,attempts:source.attempts,rate_limit_remaining:source.rateLimitRemaining});
try {
  let discovered,details,leagues=[],classifyLeague;
  if(fixture){
    const data=JSON.parse(await readFile(fixture,'utf8'));
    discovered=data.proMatches;details=data.details;leagues=data.leagues??[];
    if(!Array.isArray(discovered)||!details||typeof details!=='object')throw Object.assign(new Error(),{code:'invalid_fixture'});
  }else{
    const ingestion=await import('../packages/ingestion/dist/index.js');classifyLeague=ingestion.classifyLeague;
    runtime=ingestion.createProviderRuntime(process.env,Math.min(200,(sample+(teamIds?.length??0)+2)*3));
    if(teamIds){
      const captured=await ingestion.captureCurrentHistory(runtime.client,teamIds,sample);
      currentHistory=ingestion.validateCurrentHistoryCapture(captured);
      const bytes=JSON.stringify(captured,null,2)+'\n';await captureOutput.writeFile(bytes);
      captureRef={file:captureFile,sha256:createHash('sha256').update(bytes).digest('hex'),cutoffAt:captured.cutoffAt,
        eligibleMatchIds:currentHistory.matches.filter(m=>m.eligible).map(m=>m.matchId),
        excluded:currentHistory.matches.filter(m=>!m.eligible).map(m=>({matchId:m.matchId,reasons:m.reasons}))};
      selection=currentHistory.selection;discovered=selection.selected;leagues=currentHistory.leagues.data;
      sourceEvidence.push(...[currentHistory.heroes,currentHistory.leagues,...currentHistory.discoveries].map(o=>evidence(o.source)));
      errors.push(...captured.errors.map(e=>({match_id:e.matchId,code:e.code,status:e.status,retry_after_ms:null})));
    }else{
      const catalog=await runtime.client.getLeagues();leagues=catalog.data;sourceEvidence.push(evidence(catalog.source));
      const discovery=leagueId===null?await runtime.client.getProMatches():await runtime.client.getLeagueMatches(leagueId);
      discovered=discovery.data;sourceEvidence.push(evidence(discovery.source));
    }
  }
  if(!currentHistory)selection=selectAuditMaps(discovered,sample,leagueId);
  if(selection.selected.length===0)throw Object.assign(new Error(),{code:'empty_discovery'});
  for(const candidate of selection.selected){
    const id=candidate.match_id;
    try{
      const captured=currentHistory?.matches.find(m=>m.matchId===id);
      if(currentHistory&&!captured)continue; // Captured HTTP failure is already recorded, never silently refetched.
      const observation=fixture?null:currentHistory?captured.observation:await runtime.client.getMatchSource(id);
      const m=fixture?details[id]:JSON.parse(observation.rawBody);
      if(!m)throw Object.assign(new Error(),{code:'missing_fixture_detail'});
      const q=inspectMatch(m,id),actualLeague=canonicalId(m.leagueid);
      const matches=leagues.filter(league=>canonicalId(league.leagueid)===actualLeague);
      const pro=matches.length===1&&classifyLeague?classifyLeague(matches[0].tier):null;
      const expectedLeague=leagueId??canonicalId(candidate.leagueid);
      const cohort=captured?.reasons.some(r=>['DISCOVERY_DETAIL_CONFLICT','TARGET_ORGANIZATION_MISSING','SOURCE_SCHEMA_INVALID'].includes(r))?false:
        expectedLeague===null||actualLeague===null?null:expectedLeague===actualLeague;
      const fetchedAt=observation?.source.fetchedAt??null;
      const start=Number.isSafeInteger(m.start_time)&&m.start_time>0?new Date(m.start_time*1000):null;
      const startedAt=start&&Number.isFinite(start.getTime())?start.toISOString():null;
      const completed=fetchedAt!==null&&startedAt!==null&&typeof m.radiant_win==='boolean'&&Number.isSafeInteger(m.duration)&&m.duration>0?
        start.getTime()+m.duration*1000<=Date.parse(fetchedAt):fetchedAt===null?null:false;
      rows.push({match_id:id,started_at:startedAt,provider_patch_id:q.flags.patch?m.patch:null,league_id:actualLeague,
        game_mode:q.diagnostics.game_mode,lobby_type:q.diagnostics.lobby_type,league_tier:matches.length===1?matches[0].tier??null:null,
        ...q,flags:{...q.flags,confirmed_pro:cohort!==false&&q.flags.match_id_consistent?pro:false,completed_outcome:completed,
          discovery_cohort_consistent:cohort,game_mode:Number.isSafeInteger(m.game_mode)&&m.game_mode>0,
          lobby_type:Number.isSafeInteger(m.lobby_type)&&m.lobby_type>=0,canonical_identity_10:null,verified_patch:null,
          pre_match_lineup_known_at:null,post_draft_heroes_known_at:null},source_evidence:observation?evidence(observation.source):null});
    }catch(error){errors.push(safeAuditError(error,id));}
  }
}catch(error){errors.push(safeAuditError(error));}
finally{
  const report=buildAuditReport({mode:fixture?'synthetic_fixture':'live_opendota',requested:sample,selection,rows,errors,
    requests:runtime?.client.requestStats??{attempts:0,httpStatuses:{},transportErrors:{}},sourceEvidence,leagueId,generatedAt:new Date().toISOString()});
  if(captureRef)report.current_history_capture=captureRef;
  try{
    if(reportOutput)await reportOutput.writeFile(JSON.stringify(report,null,2)+'\n');
    else if(output){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
    console.log(JSON.stringify(report,null,2));if(report.status!=='complete')process.exitCode=1;
  }finally{await runtime?.close();await captureOutput?.close();await reportOutput?.close();}
}
