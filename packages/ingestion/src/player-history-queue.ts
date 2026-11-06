import {PgBoss} from 'pg-boss';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {sql,CompiledQuery,PlayerHistoryRepository,PlayerHistoryResumeRepository,PlayerHistoryResumeError,historyResumeScope,playerHistoryKey,type Db,type PlayerHistoryRow} from '@dota/db';
import {PlayerHistoryReportSchema,PlayerHistoryOptionsSchema,type PlayerHistoryOptions,type PlayerHistoryBinding,type PlayerHistoryReport} from '@dota/contracts';
import {capturePlayerHistory,type PlayerHistoryProvider} from './player-history.js';
import {IngestionService} from './importer.js';
import {OpenDotaError,OpenDotaClient} from './opendota/client.js';
import {OpenDotaPlayerHistoryClient} from './opendota/player-history.js';
import {MatchSourceSchema} from './opendota/schemas.js';
import {PostgresProviderBudget} from './quota.js';
import {enrichHistoryEvidence,historyParticipantAccounts,historyReadiness} from './history-enrichment.js';
import {executeHistoryEvidenceResume} from './history-resume.js';
export const PLAYER_HISTORY_QUEUE='opendota-player-history';
export async function setupPlayerHistoryQueue(boss:PgBoss){await boss.createQueue(PLAYER_HISTORY_QUEUE,{policy:'exclusive',retryLimit:1,retryDelay:30,expireInSeconds:1800,heartbeatSeconds:30});}
export async function createPlayerHistoryQueue(connectionString:string){
 const boss=new PgBoss({connectionString});boss.on('error',()=>console.error(JSON.stringify({event:'player_history_queue_error'})));
 try{await boss.start();await setupPlayerHistoryQueue(boss);return boss;}catch(e){await boss.stop({graceful:false}).catch(()=>undefined);throw e;}
}
export class PlayerHistoryOptionsConflict extends Error{}
export async function enqueuePlayerHistoryResume(boss:PgBoss,db:Db,owner:string,runId:string){
 const requested=await new PlayerHistoryRepository(db).get(runId);
 if(!requested||requested.owner_user_id!==owner)throw new PlayerHistoryResumeError('resume_source_unavailable');
 const root=await new PlayerHistoryResumeRepository(db).root(requested),scope=historyResumeScope(root),baseKey=playerHistoryKey(root.bindings);
 return db.transaction().execute(async tx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`player-history:${baseKey}`},0))`.execute(tx);
  const current=await new PlayerHistoryRepository(tx).bindings(root.bindings.map(p=>p.playerId));
  if(!current||playerHistoryKey(current,root.options)!==root.lineup_key)throw new PlayerHistoryResumeError('identity_changed');
  const active=(await sql<PlayerHistoryRow>`SELECT * FROM player_history_runs WHERE bindings=${JSON.stringify(root.bindings)}::jsonb AND status IN ('queued','running') LIMIT 1`.execute(tx)).rows[0];
  if(active){if(active.lineup_key!==root.lineup_key)throw new PlayerHistoryOptionsConflict();return active.id;}
  const previous=await new PlayerHistoryRepository(tx).latest(owner,root.lineup_key);
  if(previous&&previous.next_allowed_at.getTime()>Date.now())return previous.id;
  const id=randomUUID();await sql`INSERT INTO player_history_runs(id,owner_user_id,lineup_key,bindings,options,status,operation,parent_run_id,scope_map_ids)
   VALUES(${id}::uuid,${owner}::uuid,${root.lineup_key},${JSON.stringify(root.bindings)}::jsonb,${JSON.stringify(root.options)}::jsonb,'queued','evidence_resume',${root.id}::uuid,${JSON.stringify(scope)}::jsonb)`.execute(tx);
  const connection={executeSql:async(text:string,values:unknown[])=>({rows:(await tx.executeQuery(CompiledQuery.raw(text,values))).rows})};
  if(!await boss.send(PLAYER_HISTORY_QUEUE,{runId:id},{id,singletonKey:root.lineup_key,expireInSeconds:1800,db:connection}))throw Error('history_resume_queue_conflict');return id;
 });
}
export async function enqueuePlayerHistory(boss:PgBoss,db:Db,owner:string,bindings:PlayerHistoryBinding[],inputOptions:PlayerHistoryOptions={windowDays:90,maxMaps:10}){
 const options=PlayerHistoryOptionsSchema.parse(inputOptions),key=playerHistoryKey(bindings,options),baseKey=playerHistoryKey(bindings),sorted=[...bindings].sort((a,b)=>a.playerId.localeCompare(b.playerId));
 return db.transaction().execute(async tx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`player-history:${baseKey}`},0))`.execute(tx);
  const active=(await sql<PlayerHistoryRow>`SELECT * FROM player_history_runs WHERE bindings=${JSON.stringify(sorted)}::jsonb AND status IN ('queued','running') LIMIT 1`.execute(tx)).rows[0];
  if(active){if(active.lineup_key!==key)throw new PlayerHistoryOptionsConflict();return active.id;}
  const previous=(await sql<PlayerHistoryRow&{blocked:boolean}>`SELECT *,next_allowed_at>clock_timestamp() AS blocked FROM player_history_runs WHERE lineup_key=${key} ORDER BY created_at DESC,id DESC LIMIT 1`.execute(tx)).rows[0];
  if(previous&&(previous.status==='queued'||previous.status==='running'||previous.blocked))return previous.id;
  const id=randomUUID();await sql`INSERT INTO player_history_runs(id,owner_user_id,lineup_key,bindings,options,status) VALUES(${id}::uuid,${owner}::uuid,${key},${JSON.stringify(sorted)}::jsonb,${JSON.stringify(options)}::jsonb,'queued')`.execute(tx);
  const connection={executeSql:async(text:string,values:unknown[])=>({rows:(await tx.executeQuery(CompiledQuery.raw(text,values))).rows})};
  if(!await boss.send(PLAYER_HISTORY_QUEUE,{runId:id},{id,singletonKey:key,expireInSeconds:1800,db:connection}))throw new Error('player_history_queue_conflict');return id;
 });
}
export function livePlayerHistoryProvider(db:Db,env:NodeJS.ProcessEnv,signal?:AbortSignal):PlayerHistoryProvider{
 const budget=new PostgresProviderBudget(db,{rpm:Number(env.OPENDOTA_RPM_BUDGET??45),daily:Number(env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(env.OPENDOTA_MONTHLY_BUDGET??45000)});
 const client=new OpenDotaClient({apiKey:env.OPENDOTA_API_KEY,maxRequests:104,attempts:2,timeoutMs:10000,maxWaitMs:5000},{budget,signal});
 const discovery=new OpenDotaPlayerHistoryClient(budget,{apiKey:env.OPENDOTA_API_KEY});
 const identities=new OpenDotaClient({apiKey:env.OPENDOTA_API_KEY,maxRequests:42,attempts:2,timeoutMs:10000,maxWaitMs:5000},{budget,signal});
 return {discover:(ids,cutoff,options,page)=>discovery.discover(ids,cutoff,options,page),getHeroes:()=>client.getHeroes(),getLeagues:()=>client.getLeagues(),getMatchSource:id=>client.getMatchSource(id),getProPlayers:()=>identities.getProPlayers(),getPlayer:id=>identities.getPlayer(id)};
}
export async function executePlayerHistory(db:Db,runId:string,attempt:number,provider:PlayerHistoryProvider,signal?:AbortSignal){
 const repo=new PlayerHistoryRepository(db),token=randomUUID(),row=await repo.start(runId,token,attempt);if(!row)return;
 console.log(JSON.stringify({event:'player_history_started',run_id:runId,attempt}));
 const options=PlayerHistoryOptionsSchema.parse(row.options);
 let report:PlayerHistoryReport|null=null,audit:unknown=null;
 const current=async()=>{if(signal?.aborted||!await repo.active(runId,token))throw Error('player_history_stale_attempt');
  const actual=await repo.bindings(row.bindings.map(p=>p.playerId));return actual!==null&&playerHistoryKey(actual,options)===row.lineup_key;};
 try{
  if(!await current()){await repo.finish(runId,token,'error',null,null,'identity_changed');return;}
  if(row.operation==='evidence_resume'){await executeHistoryEvidenceResume(db,row,token,provider,current);return;}
  const capture=await capturePlayerHistory(provider,row.bindings.map(p=>p.accountId),new Date().toISOString(),options),{maps,candidates,cutoffAt}=capture;
  report=PlayerHistoryReportSchema.parse({policyVersion:'selected-player-history-v3',options,discoveryPages:capture.discovery.observations.length,cutoffAt,fromAt:new Date(Math.floor(Date.parse(cutoffAt)/1000)*1000-options.windowDays*86400000).toISOString(),fetchedAt:new Date().toISOString(),
   selected:candidates.length,accepted:0,duplicates:0,excluded:maps.filter(m=>!m.eligible).length,failed:capture.errors.length,conflicts:0,
   players:row.bindings.map(p=>({...p,discovered:capture.discovery.rows.filter(r=>r.account_id===p.accountId).length,sourceLimitReached:capture.discovery.limitReached.includes(p.accountId),selected:candidates.filter(c=>c.players.some(r=>r.account_id===p.accountId)).length,accepted:0})),
   maps:[...maps.filter(m=>!m.eligible).map(m=>({matchId:m.candidate.matchId,status:'excluded',reasons:m.reasons})),...capture.errors.map(e=>({matchId:e.matchId,status:'error',reasons:[e.code]}))]});
  audit={options,discoveryRows:capture.discovery.rows,sources:[...capture.discovery.observations,capture.heroes,capture.leagues,...maps.map(m=>m.observation)].map(o=>({endpoint:o.source.endpoint,payloadSha256:o.source.payloadSha256,fetchedAt:o.source.fetchedAt,knownAt:o.source.knownAt,attempts:o.source.attempts})),predictionEligibility:'not_assessed',trainingExamples:0};
  const importer=new IngestionService(db,{getHeroes:async()=>capture.heroes,getLeagues:async()=>capture.leagues,getMatchSource:async id=>{
   const m=maps.find(m=>m.candidate.matchId===id&&m.eligible);if(!m)throw Error('outside_player_history');return {...m.observation,data:MatchSourceSchema.parse(JSON.parse(m.observation.rawBody))};}});
  for(const m of maps.filter(m=>m.eligible)){
   if(!await current()){await repo.finish(runId,token,'partial',report,audit,'identity_changed');return;}
   const result=await importer.ingest(m.candidate.matchId),accepted=result.status==='accepted'||result.status==='partial';
   if(accepted){report.accepted++;if(result.duplicate)report.duplicates++;for(const p of report.players)if(m.candidate.players.some(r=>r.account_id===p.accountId))p.accepted++;}
   else if(result.status==='conflict')report.conflicts++;else report.excluded++;
   report.maps.push({matchId:m.candidate.matchId,status:accepted?(result.duplicate?'duplicate':'accepted'):result.status==='conflict'?'conflict':'excluded',reasons:accepted?[]:['IMPORT_'+result.status.toUpperCase()]});
  }
  const acceptedIds=new Set(report.maps.filter(m=>m.status==='accepted'||m.status==='duplicate').map(m=>m.matchId));
  const acceptedMaps=maps.filter(m=>acceptedIds.has(m.candidate.matchId)&&m.match!==null);
  const enrichmentEvidence:unknown[]=[];audit={...(audit as Record<string,unknown>),enrichmentEvidence,predictionEligibility:'history_only_not_model_validation'};
  report.enrichment=await enrichHistoryEvidence(db,provider,historyParticipantAccounts(acceptedMaps.map(m=>m.match!)),acceptedMaps.flatMap(m=>m.match?.series_id?[m.match.series_id]:[]),current,value=>enrichmentEvidence.push(value));
  // Keep the original bytes/SHA/clocks in memory: stored receipts contain a projection, not these bytes.
  for(const m of acceptedMaps){if(!await current())throw Error('player_history_stale_attempt');const replay=await importer.ingest(m.candidate.matchId);
   if(replay.status==='accepted'||replay.status==='partial')report.enrichment.replayedMaps++;
   else report.enrichment.reasons.push('REPLAY_'+replay.status.toUpperCase());}
  report.enrichment=await historyReadiness(db,row.bindings,report.enrichment);
  if(!await current())throw Error('player_history_stale_attempt');
  await repo.finish(runId,token,report.failed+report.excluded+report.conflicts>0?'partial':'completed',report,audit);
  console.log(JSON.stringify({event:'player_history_finished',run_id:runId,accepted:report.accepted,failed:report.failed,excluded:report.excluded}));
 }catch(e){const code=e instanceof OpenDotaError?e.code:'import_failed';
  await repo.finish(runId,token,report?.accepted?'partial':'error',report,{capture:audit,failure:{code}},e instanceof OpenDotaError?'source_unavailable':'import_failed',e instanceof OpenDotaError?e.retryAfterMs??60000:60000);
  console.error(JSON.stringify({event:'player_history_failed',run_id:runId,code}));}
}
export async function registerPlayerHistoryWorker(boss:PgBoss,db:Db,provider:(signal:AbortSignal)=>PlayerHistoryProvider){
 await setupPlayerHistoryQueue(boss);
 return boss.work<unknown>(PLAYER_HISTORY_QUEUE,{batchSize:1,pollingIntervalSeconds:1},async jobs=>{
  const job=jobs[0]!,input=z.object({runId:z.uuid()}).strict().parse(job.data);
  await executePlayerHistory(db,input.runId,job.retryCount+1,provider(job.signal),job.signal);
 });
}
