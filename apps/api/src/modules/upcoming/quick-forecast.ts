import {createHash,randomUUID} from 'node:crypto';
import {ScenarioInputSchema,tier1ScopeMismatch,V1ScheduleTargetSavedSchema,type Tier1Scope,type V1ScheduleTargetSaved} from '@dota/contracts';
import {sql,FreshPageScheduleTargetRepository,RosterCatalogueRepository,Tier1ScopeRepository,type Db,type PageScheduledPredictionService} from '@dota/db';
import {TemplateLineupSchema} from '../catalog/lineup-templates-contract.js';
import {QuickForecastPlanSchema,QuickForecastRequestSchema,QuickForecastResponseSchema,type QuickForecastRequest,type QuickForecastStage} from './quick-forecast-contract.js';
import {UnclassifiedScheduledForecastService} from './unclassified-scheduled-runtime.js';
import type {UpcomingService} from './service.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export class QuickForecastError extends Error{
 constructor(readonly code:string,message:string,readonly leagueId:string|null=null){super(message);}
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const roles=(rows:QuickForecastRequest['lineupA'])=>rows.map(p=>({playerId:p.playerId,rolePos:p.rolePos})).sort((a,b)=>a.rolePos-b.rolePos);
/** Orchestration only. Reuses existing schedule admission and registered inference unchanged. */
export class QuickForecastService{
 private readonly targets:FreshPageScheduleTargetRepository;
 private readonly scopes:Tier1ScopeRepository;
 constructor(private readonly db:Db,private readonly upcoming:Pick<UpcomingService,'schedule'>,
  private readonly predictions:Pick<PageScheduledPredictionService,'createScheduled'>,
  private readonly bindings:Pick<RosterCatalogueRepository,'latest'>=new RosterCatalogueRepository(db),
  private readonly unclassified:UnclassifiedScheduledForecastService=new UnclassifiedScheduledForecastService(db)){
  this.targets=new FreshPageScheduleTargetRepository(db);this.scopes=new Tier1ScopeRepository(db);
 }
 private async existing(owner:string,id:string,matchId:string,input:QuickForecastRequest){
  const row=(await sql<{request:unknown;plan:unknown;provider_match_id:string}>`SELECT request,plan,provider_match_id::text FROM upcoming_forecast_preparations
   WHERE owner_user_id=${owner}::uuid AND request_id=${id}::uuid`.execute(this.db)).rows[0];
  if(!row)return null;
  if(row.provider_match_id!==matchId||!same(QuickForecastRequestSchema.parse(row.request),input))
   throw new QuickForecastError('REQUEST_CONFLICT','Эта попытка уже сохранена с другими параметрами. Начните новый расчёт.');
  return QuickForecastPlanSchema.parse(row.plan);
 }
 async run(owner:string,matchId:string,raw:QuickForecastRequest,progress:(stage:QuickForecastStage,reused?:boolean)=>void=()=>{}){
  progress('request');
  const input=QuickForecastRequestSchema.parse(raw);
  let plan=await this.existing(owner,input.requestId,matchId,input);
  if(!plan)plan=await this.prepare(owner,matchId,input,progress);
  else progress('map',true);
  if(plan.saveScope&&plan.scope)await this.scopes.write(owner,{requestId:input.requestId,scopeId:input.requestId,expectedRevision:0,enabled:true,scope:plan.scope});
  // Target creation and forecast creation each have their original durable request idempotency.
  const target=await this.targets.create(owner,plan.target);
  await this.targets.assertForecastFresh(owner,target.record.request.requestId,input.requestId);
  progress('analysis');
  const forecast=await (plan.scope?this.predictions:this.unclassified).createScheduled(owner,target.record.request.requestId,{
   requestId:input.requestId,scenarioId:plan.scenarioId,expectedRevision:1,targetSha256:target.sha256,targetScope:plan.scope});
  const response=QuickForecastResponseSchema.parse({targetId:target.record.request.requestId,scenarioId:plan.scenarioId,forecast});
  progress('complete');return response;
 }
 private async prepare(owner:string,matchId:string,input:QuickForecastRequest,progress:(stage:QuickForecastStage)=>void){
  progress('schedule');
  let preview=await this.targets.preview(matchId);
  if(preview.reasons.includes('SCHEDULE_SOURCE_STALE')){
   const page=Number(new URL('https://api.pandascore.co'+preview.observation.endpoint).searchParams.get('page'));
   await this.upcoming.schedule(true,page);preview=await this.targets.preview(matchId);
  }
  if(!preview.eligible)throw new QuickForecastError('SCHEDULE_UNAVAILABLE','Расписание не подтверждает будущую встречу. Обновление выполнено при необходимости; дождитесь актуальных данных.');
  const match=preview.observation.match;
  const ids=match.opponents.map(t=>t.providerTeamId);
  if(ids.length!==2||input.providerTeamAId===input.providerTeamBId||!ids.includes(input.providerTeamAId)||!ids.includes(input.providerTeamBId))
   throw new QuickForecastError('PARTICIPANTS_CHANGED','Участники встречи изменились. Перечитайте встречу и проверьте составы.');
  progress('lineups');
  const bindings=await Promise.all([this.bindings.latest(owner,input.providerTeamAId),this.bindings.latest(owner,input.providerTeamBId)]);
  if(!bindings[0]?.usable||!bindings[1]?.usable||bindings[0].teamId!==input.teamAId||bindings[1].teamId!==input.teamBId)
   throw new QuickForecastError('TEAM_MAPPING_REQUIRED','Сначала подтвердите соответствие команд и пятёрки в этой встрече.');
  // Reuse only exact provider tournament/series/league identity, never similar display names.
  const candidates=(await sql<{request_id:string}>`SELECT request_id::text FROM (
   SELECT DISTINCT ON(provider_match_id) * FROM v1_schedule_targets WHERE owner_user_id=${owner}::uuid
   ORDER BY provider_match_id,revision DESC) latest
   WHERE record_text::jsonb#>>'{observation,match,tournament,providerTournamentId}'=${match.tournament.providerTournamentId}
    AND record_text::jsonb#>>'{observation,match,league,providerLeagueId}'=${match.league.providerLeagueId}
    AND (record_text::jsonb#>>'{observation,match,eventSeries,providerEventSeriesId}') IS NOT DISTINCT FROM ${match.eventSeries?.providerEventSeriesId??null}
   ORDER BY recorded_at DESC LIMIT 101`.execute(this.db)).rows;
  const previous:V1ScheduleTargetSaved[]=[];
  for(const row of candidates.slice(0,100))previous.push(V1ScheduleTargetSavedSchema.parse(await this.targets.get(owner,row.request_id)));
  const leagueIds=[...new Set(previous.map(t=>t.record.request.leagueId).filter((s):s is string=>!!s))];
  const leagueId=input.tournament?.leagueId??(candidates.length<=100&&leagueIds.length===1?leagueIds[0]!:null);
  const allScopes:Tier1Scope[]=[];let context:Awaited<ReturnType<Tier1ScopeRepository['list']>>['context']|null=null,complete=false;
  for(let offset=0;leagueId&&offset<100;offset+=20){
   const list=await this.scopes.list(owner,{localLeagueId:leagueId,at:match.scheduledAt!,offset});context=list.context;
   allScopes.push(...list.items.map(s=>s.record.request.scope).filter(s=>!tier1ScopeMismatch(s,list.context)));
   if(!list.hasMore){complete=true;break;}
  }
  const unique=[...new Map(allScopes.map(s=>[JSON.stringify(s),s])).values()];
  const scope=input.tournament?.scope??(complete&&unique.length===1?unique[0]!:null);
  if(input.tournament&&(!scope||!context||tier1ScopeMismatch(scope,context)))throw new QuickForecastError('TOURNAMENT_REQUIRED','Проверьте событие Tier 1 и период турнира. Настройка сохранится для следующих встреч этого события.',leagueId);
  // Explicit tournament selection is owner administration. Ordinary forecast use needs no new assertion.
  if(input.tournament){
   const actor=(await sql<{account_role:string}>`SELECT account_role FROM app_users WHERE id=${owner}::uuid AND is_active`.execute(this.db)).rows[0];
   if(actor?.account_role!=='owner')throw new QuickForecastError('OWNER_REQUIRED','Настройку нового турнира выполняет владелец.');
  }
  progress('map');
  const history=await this.targets.history(owner,matchId);
  const target={requestId:randomUUID(),providerMatchId:matchId,observationId:preview.observation.id,observationSha256:preview.observation.snapshotSha256,
   expectedRevision:history.items[0]?.record.revision??0,mapNumber:1 as const,providerTeamAId:input.providerTeamAId,providerTeamBId:input.providerTeamBId,
   teamAId:input.teamAId,teamBId:input.teamBId,leagueId,reviewSourceUrl:scope?.sourceUrl??`https://api.pandascore.co/dota2/matches/${matchId}`,
   reason:'Автоматическая подготовка по сохранённым связям команд и свежему расписанию; уровень турнира не утверждается.'};
  const prepared=await this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'quick-forecast:'+owner+':'+input.requestId},0))`.execute(tx);
   const old=(await sql<{request:unknown;plan:unknown;provider_match_id:string}>`SELECT request,plan,provider_match_id::text FROM upcoming_forecast_preparations WHERE owner_user_id=${owner}::uuid AND request_id=${input.requestId}::uuid`.execute(tx)).rows[0];
   if(old){if(old.provider_match_id!==matchId||!same(QuickForecastRequestSchema.parse(old.request),input))throw new QuickForecastError('REQUEST_CONFLICT','Попытка уже использована с другими параметрами.');return QuickForecastPlanSchema.parse(old.plan);}
   // Lock team writers; template saves use this same team advisory lock.
   for(const teamId of [input.teamAId,input.teamBId].sort())await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lineup-template-team:'+teamId},0))`.execute(tx);
   const now=(await sql<{at:Date}>`SELECT clock_timestamp() at`.execute(tx)).rows[0]!.at.toISOString();
   const templates:{teamId:string;revision:number;confirmedAt:string}[]=[];
   for(const [teamId,lineup] of [[input.teamAId,input.lineupA],[input.teamBId,input.lineupB]] as const){
    const row=(await sql<{lineup:unknown;revision:number;confirmed_at:Date}>`SELECT lineup,revision,confirmed_at FROM owner_lineup_templates WHERE team_id=${teamId}::bigint ORDER BY revision DESC LIMIT 1 FOR SHARE`.execute(tx)).rows[0];
    if(!row||row.confirmed_at.toISOString()>now||!same(roles(lineup),[...TemplateLineupSchema.parse(row.lineup)].sort((a,b)=>a.rolePos-b.rolePos)))
     throw new QuickForecastError('LINEUPS_CHANGED','Подтверждённый состав или роли изменились. Проверьте пятёрки ещё раз.');
    templates.push({teamId,revision:row.revision,confirmedAt:row.confirmed_at.toISOString()});
   }
   // Requested boundary is map start; the existing executor caps the effective cutoff at calculation time.
   // This keeps the committed lineup strictly earlier than the effective feature cutoff.
   const scenario=ScenarioInputSchema.parse({title:(match.name??'Первая карта встречи').slice(0,120),teamAId:input.teamAId,teamBId:input.teamBId,
    cutoffAt:match.scheduledAt,scheduledAt:match.scheduledAt,confirmedByOwner:true,lineupA:[...input.lineupA].sort((a,b)=>a.rolePos-b.rolePos),lineupB:[...input.lineupB].sort((a,b)=>a.rolePos-b.rolePos),
    expectedLineupA:null,expectedLineupB:null,context:{seriesId:null,leagueId,mapNumber:1,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,firstPickSlot:null,venueKind:null,tournamentStage:null}});
   if(!scenario.scheduledAt||scenario.scheduledAt<=now)throw new QuickForecastError('SCHEDULE_UNAVAILABLE','Встреча уже началась. Новый прогноз первой карты недоступен.');
   // A deliberately narrow blank pre-match scenario writer: no draft, expected roster, side or series guesses.
   // Scenario + immutable input + durable request are committed atomically.
   const scenarioId=randomUUID(),body=JSON.stringify(scenario);
   await sql`INSERT INTO scenarios(id,owner_user_id,title,team_a_id,team_b_id,cutoff_at,scheduled_at,map_number,league_id)
    VALUES(${scenarioId}::uuid,${owner}::uuid,${scenario.title},${input.teamAId}::bigint,${input.teamBId}::bigint,${scenario.cutoffAt}::timestamptz,${scenario.scheduledAt}::timestamptz,1,${leagueId}::bigint)`.execute(tx);
   for(const [slot,lineup] of [['A',scenario.lineupA],['B',scenario.lineupB]] as const)for(const p of lineup)
    await sql`INSERT INTO scenario_lineup(scenario_id,team_slot,role_pos,player_id,is_standin) VALUES(${scenarioId}::uuid,${slot},${p.rolePos},${p.playerId}::bigint,${p.isStandin})`.execute(tx);
   await sql`INSERT INTO scenario_input_snapshots(scenario_id,revision,input_snapshot,input_hash) VALUES(${scenarioId}::uuid,1,${body}::jsonb,${hash(body)})`.execute(tx);
   const plan=QuickForecastPlanSchema.parse({target,scenarioId,scope,templates,saveScope:!!input.tournament&&!allScopes.some(s=>same(s,scope))});
   await sql`INSERT INTO upcoming_forecast_preparations(owner_user_id,request_id,provider_match_id,request,plan,scenario_id)
    VALUES(${owner}::uuid,${input.requestId}::uuid,${matchId}::bigint,${JSON.stringify(input)}::jsonb,${JSON.stringify(plan)}::jsonb,${scenarioId}::uuid)`.execute(tx);
   return plan;
  });
  return prepared;
 }
}
