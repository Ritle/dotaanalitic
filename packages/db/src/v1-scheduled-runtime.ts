import type {ScenarioSnapshot,V1ScheduledRealTarget} from '@dota/contracts';
import {sql,type Db,type Executor} from './index.js';
import {V1ScheduleTargetRepository} from './v1-schedule-target.js';
import {registryHash} from './v1-registry.js';

/** Caller holds these locks until the immutable runtime snapshot commits. No provider I/O. */
export async function bindScheduledRuntime(db:Db,tx:Executor,owner:string,ref:V1ScheduledRealTarget,scenario:ScenarioSnapshot){
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-schedule-target:'+owner},0))`.execute(tx);
  await sql`LOCK TABLE upcoming_source_observations IN SHARE MODE`.execute(tx);
  const repository=new V1ScheduleTargetRepository(db),target=await repository.get(owner,ref.targetRequestId,tx),r=target.record;
  if(target.sha256!==ref.targetSha256||r.request.providerMatchId!==ref.providerMatchId)throw Error('scheduled_target_reference_mismatch');
  const latest=(await sql<{request_id:string}>`SELECT request_id FROM v1_schedule_targets WHERE owner_user_id=${owner}::uuid
    AND provider_match_id=${ref.providerMatchId}::bigint ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
  if(latest?.request_id!==ref.targetRequestId)throw Error('scheduled_target_revision_changed');
  const current=await repository.preview(ref.providerMatchId,tx);
  if(!current.eligible)throw Error('scheduled_target_not_upcoming');
  if(registryHash(current.observation.match)!==registryHash(r.observation.match))throw Error('scheduled_target_source_changed');
  if(current.observation.fetchedAt.slice(0,-1)+'000Z'>current.checkedAt||r.selectedAt>current.checkedAt)
    throw Error('scheduled_target_clock_invalid');
  const s=scenario.input;
  if(s.teamAId!==r.request.teamAId||s.teamBId!==r.request.teamBId||s.context.leagueId!==r.request.leagueId||
    s.scheduledAt!==r.observation.match.scheduledAt||s.context.mapNumber!==1||s.context.seriesId!==null||
    (s.context.teamASeriesWinsBefore??0)!==0||(s.context.teamBSeriesWinsBefore??0)!==0)
    throw Error('scheduled_target_scenario_mismatch');
  return {format:'v1-schedule-runtime-binding-v1',target,currentObservation:current.observation,
    checkedAt:current.checkedAt,omittingLaterPages:current.omittingLaterPages};
}
