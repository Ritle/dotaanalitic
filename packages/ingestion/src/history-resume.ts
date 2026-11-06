import {PlayerHistoryReportSchema,type PlayerHistoryReport} from '@dota/contracts';
import {PlayerHistoryRepository,PlayerHistoryResumeRepository,historyResumeScope,type Db,type PlayerHistoryRow} from '@dota/db';
import {enrichHistoryEvidence,historyParticipantAccounts,historyReadiness} from './history-enrichment.js';
import {prepareStoredHistoryProjection} from './history-resume-projection.js';
import {IngestionService} from './importer.js';
import type {PlayerHistoryProvider} from './player-history.js';
export async function executeHistoryEvidenceResume(db:Db,row:PlayerHistoryRow,token:string,provider:PlayerHistoryProvider,current:()=>Promise<boolean>){
 const runs=new PlayerHistoryRepository(db),stored=new PlayerHistoryResumeRepository(db);let report:PlayerHistoryReport|null=null;
 const audit:{operation:string;parentRunId:string|null;predictionEligibility:string;trainingExamples:number;projections:unknown[];enrichmentEvidence:unknown[]}={operation:'evidence_resume',parentRunId:row.parent_run_id,predictionEligibility:'history_only_not_model_validation',trainingExamples:0,projections:[],enrichmentEvidence:[]};
 const check=async()=>{if(!await current())throw Error('player_history_stale_attempt');};
 try{
  await check();const root=await stored.root(row),parent=PlayerHistoryReportSchema.parse(root.report),scope=historyResumeScope(root);
  if(JSON.stringify(scope)!==JSON.stringify(row.scope_map_ids))throw Error('history_resume_scope_changed');
  report=PlayerHistoryReportSchema.parse({policyVersion:'selected-player-history-v4',operation:'evidence_resume',parentRunId:root.id,options:row.options,
   cutoffAt:parent.cutoffAt,fromAt:parent.fromAt,fetchedAt:new Date().toISOString(),selected:scope.length,accepted:0,duplicates:0,excluded:0,failed:0,conflicts:0,
   players:row.bindings.map(p=>({...p,discovered:0,selected:0,accepted:0})),maps:[]});
  const maps:Array<{id:string;capture:ReturnType<typeof prepareStoredHistoryProjection>}>=[];
  for(const id of scope){await check();try{
   const capture=prepareStoredHistoryProjection(await stored.projection(root,id),new Date().toISOString());maps.push({id,capture});audit.projections.push(capture.manifest);
   for(const p of report.players)if(capture.match.data.players?.some(x=>x.account_id===p.accountId))p.selected++;
  }catch{report.excluded++;report.maps.push({matchId:id,status:'excluded',reasons:['STORED_PROJECTION_UNAVAILABLE']});}}
  const accounts=await stored.accountOrder(historyParticipantAccounts(maps.map(m=>m.capture.match.data)));
  report.enrichment=await enrichHistoryEvidence(db,provider,accounts,maps.flatMap(m=>m.capture.match.data.series_id&&m.capture.match.data.series_id!=='0'?[m.capture.match.data.series_id]:[]),current,v=>audit.enrichmentEvidence.push(v));
  for(const m of maps){await check();try{
   const importer=new IngestionService(db,{getHeroes:async()=>m.capture.heroes,getLeagues:async()=>m.capture.leagues,getMatchSource:async id=>{if(id!==m.id)throw Error('outside_resume_scope');return m.capture.match;}});
   const result=await importer.ingest(m.id);await check();
   await stored.record(row.id,row.attempt,m.id,result.receiptId,m.capture.manifest,m.capture.match.source.payloadSha256);
   const accepted=result.status==='accepted'||result.status==='partial';
   if(accepted){report.accepted++;report.enrichment.replayedMaps++;if(result.duplicate)report.duplicates++;for(const p of report.players)if(m.capture.match.data.players?.some(x=>x.account_id===p.accountId))p.accepted++;}
   else if(result.status==='conflict')report.conflicts++;else report.excluded++;
   report.maps.push({matchId:m.id,status:accepted?(result.duplicate?'duplicate':'accepted'):result.status==='conflict'?'conflict':'excluded',reasons:accepted?[]:['PROJECTION_'+result.status.toUpperCase()]});
  }catch(e){await check();report.failed++;report.maps.push({matchId:m.id,status:'error',reasons:['STORED_REPLAY_FAILED']});}}
  report.enrichment=await historyReadiness(db,row.bindings,report.enrichment);await check();
  await runs.finish(row.id,token,report.failed+report.excluded+report.conflicts||report.enrichment.status!=='completed'?'partial':'completed',report,audit);
 }catch{await runs.finish(row.id,token,report?.accepted?'partial':'error',report,audit,'import_failed');}
}
