import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {ScenarioSnapshotSchema,tier1ScopeMismatch,V1PredictionFeatureViewSchema,type Tier1Scope} from '@dota/contracts';
import {sql,PredictionModelRegistry,runtimeModelWarmup,runtimeModelCompatible,computeRuntimeModelFeatures,runtimeModelSnapshot,
 V1DataRepository,prepareReleaseHistory,Tier1ScopeRepository,type Db,type Executor} from '@dota/db';
// Use the existing compiled kernel without changing archived package bytes or model gates.
import {readV1RuntimeCode} from '../../../../../packages/db/dist/v1-runtime-code.js';
import {LiveEstimateRequestSchema,LiveEstimateViewSchema,liveEstimateScenario,type LiveEstimateRequest} from './estimate-contract.js';
import {LiveScheduleService} from './service.js';
import {QuickForecastError} from '../upcoming/quick-forecast.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const clock=async(db:Executor)=>(await sql<{at:Date}>`SELECT clock_timestamp() at`.execute(db)).rows[0]!.at.toISOString();
type Stored={provider_match_id:string;request_hash:string;snapshot_text:string;snapshot_sha256:string};
function view(row:Stored){
 if(hash(row.snapshot_text)!==row.snapshot_sha256)throw Error('live_estimate_integrity');
 return LiveEstimateViewSchema.parse({...JSON.parse(row.snapshot_text).view,snapshotSha256:row.snapshot_sha256});
}
export class LiveEstimateService{
 private calculating=false;
 constructor(private readonly db:Db,private readonly live:Pick<LiveScheduleService,'read'>){}
 async history(owner:string,matchId:string){
  const rows=(await sql<Stored>`SELECT provider_match_id::text,request_hash,snapshot_text,snapshot_sha256 FROM live_lineup_estimates
   WHERE owner_user_id=${owner}::uuid AND provider_match_id=${matchId}::bigint ORDER BY created_at DESC,request_id DESC LIMIT 20`.execute(this.db)).rows;
  return {items:rows.map(view)};
 }
 async run(owner:string,matchId:string,raw:LiveEstimateRequest){
  const request=LiveEstimateRequestSchema.parse(raw),requestHash=hash(JSON.stringify({matchId,request}));
  if(this.calculating)throw Error('runtime_request_busy');this.calculating=true;
  try{return await this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'live-estimate:'+owner+':'+request.requestId},0))`.execute(tx);
   const old=(await sql<Stored>`SELECT provider_match_id::text,request_hash,snapshot_text,snapshot_sha256 FROM live_lineup_estimates
    WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
   if(old){if(old.request_hash!==requestHash)throw new QuickForecastError('REQUEST_CONFLICT','Попытка уже сохранена с другими пятёрками. Начните новый расчёт.');return view(old);}
   const response=await this.live.read(false),match=response.snapshot?.data.find(m=>m.providerMatchId===matchId);
   if(response.status!=='ready'||!match||match.status!=='running')throw new QuickForecastError('LIVE_SOURCE_STALE','Обновите Live: текущий статус встречи не подтверждён свежим источником.');
   if(match.opponents.length!==2||match.opponents[0]!.providerTeamId!==request.providerTeamAId||match.opponents[1]!.providerTeamId!==request.providerTeamBId)
    throw new QuickForecastError('PARTICIPANTS_CHANGED','Участники или их порядок изменились. Выберите встречу заново.');
   const selectedAt=await clock(tx);
   // Owner-selected local players are authoritative for this hypothetical five. Never merge by nickname.
   const ids=[...request.lineupA,...request.lineupB].map(p=>p.playerId!);
   const refs=(await sql<{players:number;teams:number}>`SELECT
    (SELECT count(*)::int FROM players WHERE id=ANY(${ids}::bigint[])) players,
    (SELECT count(*)::int FROM teams WHERE id=ANY(${[request.teamAId,request.teamBId]}::bigint[])) teams`.execute(tx)).rows[0]!;
   if(refs.players!==10||refs.teams!==2)throw new QuickForecastError('VALIDATION_ERROR','Выберите команды и десять игроков из локального каталога.');
   const scopes=new Tier1ScopeRepository(this.db);
   // Reuse exact reviewed event identity; display-name matches never select a league.
   const mappings=(await sql<{league_id:string}>`SELECT DISTINCT record_text::jsonb#>>'{request,leagueId}' league_id FROM v1_schedule_targets
    WHERE owner_user_id=${owner}::uuid
    AND record_text::jsonb#>>'{observation,match,tournament,providerTournamentId}'=${match.tournament.providerTournamentId}
    AND record_text::jsonb#>>'{observation,match,league,providerLeagueId}'=${match.league.providerLeagueId}
    AND (record_text::jsonb#>>'{observation,match,eventSeries,providerEventSeriesId}') IS NOT DISTINCT FROM ${match.eventSeries?.providerEventSeriesId??null}
    UNION SELECT DISTINCT snapshot_text::jsonb#>>'{view,scenario,input,context,leagueId}' FROM live_lineup_estimates
    WHERE owner_user_id=${owner}::uuid AND snapshot_text::jsonb#>>'{view,match,tournament,providerTournamentId}'=${match.tournament.providerTournamentId}
    AND snapshot_text::jsonb#>>'{view,match,league,providerLeagueId}'=${match.league.providerLeagueId}
    AND (snapshot_text::jsonb#>>'{view,match,eventSeries,providerEventSeriesId}') IS NOT DISTINCT FROM ${match.eventSeries?.providerEventSeriesId??null}`.execute(tx)).rows;
   const leagues=[...new Set(mappings.map(r=>r.league_id).filter(Boolean))];
   const leagueId=request.tournament?.leagueId??(leagues.length===1?leagues[0]!:null);
   const at=match.beganAt??match.scheduledAt??selectedAt;
   const list=leagueId?await scopes.list(owner,{localLeagueId:leagueId,at,offset:0}):null;
   const candidates=list?list.items.map(i=>i.record.request.scope).filter(s=>!tier1ScopeMismatch(s,list.context)):[];
   const unique=[...new Map(candidates.map(s=>[JSON.stringify(s),s])).values()];
   const scope:Tier1Scope|null=request.tournament?.scope??(list&&!list.hasMore&&unique.length===1?unique[0]!:null);
   if(request.tournament&&(!scope||!list||tier1ScopeMismatch(scope,list.context)))throw new QuickForecastError('TOURNAMENT_REQUIRED','Проверьте период и уровень события. Другие турниры моделью пока не поддерживаются.',leagueId);
   const gate=await new PredictionModelRegistry(this.db).lockForPrediction(tx),code=await readV1RuntimeCode();
   const cutoffAt=await clock(tx),input=liveEstimateScenario(request,'Live · условно: '+(match.name??'выбранные пятёрки'),cutoffAt,leagueId);
   const scenario=ScenarioSnapshotSchema.parse({id:request.requestId,revision:1,input,inputHash:hash(JSON.stringify(input)),source:'manual',recordedAt:selectedAt,
    knownAt:selectedAt,eventAt:null,predictionEligibility:'not_assessed',warnings:['OWNER_ASSERTION_ONLY']});
   const reasons:string[]=[];
   if(gate.status==='unavailable')reasons.push(gate.reason);
   else if(!runtimeModelCompatible(gate,code))reasons.push('INFERENCE_CODE_MISMATCH');
   const fromAt=runtimeModelWarmup(gate);
   let source:Awaited<ReturnType<V1DataRepository['exportReleaseInventory']>>|null=null;
   let computed:ReturnType<typeof computeRuntimeModelFeatures>|null=null;
   if(cutoffAt<=fromAt)reasons.push('HISTORY_WINDOW_INVALID');
   else try{
    source=await new V1DataRepository(this.db).exportReleaseInventory({fromAt,toAt:cutoffAt,snapshotAt:cutoffAt,maxMaps:5000},code.code);
    const prepared=prepareReleaseHistory(source);
    computed=computeRuntimeModelFeatures(prepared.history,scenario,cutoffAt,reasons.length?null:gate);reasons.push(...computed.reasons);
   }catch(e){reasons.push(e instanceof Error&&e.message.includes('limit')?'HISTORY_INVENTORY_LIMIT':'HISTORY_EVIDENCE_INVALID');}
   if(!reasons.length&&computed?.probability==null)reasons.push('INFERENCE_UNAVAILABLE');
   const features=computed?.features?V1PredictionFeatureViewSchema.parse(computed.features):null;
   const result={requestId:request.requestId,providerMatchId:matchId,purpose:'live_lineup_comparison' as const,status:reasons.length?'unavailable' as const:'done' as const,
    teamAWinProbability:reasons.length?null:computed!.probability,reasons:[...new Set(reasons)],createdAt:await clock(tx),cutoffAt,scenario,match,
    modelId:gate.modelId,coverage:features?.coverage??null,players:features?{teamA:features.teamA,teamB:features.teamB}:null,
    sourceFetchedAt:response.snapshot!.source.fetchedAt,historyFromAt:fromAt,eventName:scope?.eventName??match.league.name+' · '+match.tournament.name};
   const snapshot=JSON.stringify({format:'live-lineup-estimate-v1',request,view:result,scope,tierPolicy:'optional-tier-v1',source,features:computed?.features??null,
    gate:runtimeModelSnapshot(gate),code,orchestrationSha256:hash(await readFile(new URL(import.meta.url),'utf8')),observationSource:response.snapshot!.source,
    interpretation:'Neutral single-map lineup comparison at current knowledge; not current-map or series outcome probability; no live-state or draft features.'});
   const digest=hash(snapshot);LiveEstimateViewSchema.parse({...result,snapshotSha256:digest});
   await sql`INSERT INTO live_lineup_estimates(owner_user_id,request_id,provider_match_id,request_hash,snapshot_text,snapshot_sha256)
    VALUES(${owner}::uuid,${request.requestId}::uuid,${matchId}::bigint,${requestHash},${snapshot},${digest})`.execute(tx);
   return LiveEstimateViewSchema.parse({...result,snapshotSha256:digest});
  });}finally{this.calculating=false;}
 }
}
