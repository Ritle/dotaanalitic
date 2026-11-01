import {createHash} from 'node:crypto';
import {ScheduleCacheDataSchema,RostersCacheDataSchema,UpcomingEvidenceRequestSchema,UpcomingEvidenceReportSchema,
  type UpcomingEvidenceReport,type UpcomingEvidenceReason} from '@dota/contracts';
import {sql,type Db,type Executor} from './index.js';

const SCHEDULE_ENDPOINT='/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20';
const HISTORY_LIMIT=200;
interface ObservationRow {id:string;provider:string;endpoint:string;sourceFetchedAt:string;recordedAt:string;
  sourcePayloadSha256:string;snapshotSha256:string;snapshotText:string}
export class UpcomingEvidenceError extends Error {
  constructor(readonly code:'invalid_observation'|'future_cutoff'){super(code);}
}
const microseconds=(time:string)=>time.slice(0,-1)+'000Z';
const unique=(ids:string[])=>new Set(ids).size===ids.length;

async function observations(db:Executor,key:string,cutoff:string,limit:number){
  return (await sql<ObservationRow>`SELECT id::text AS id,provider,source_endpoint AS endpoint,
    to_char(source_fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceFetchedAt",
    to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",
    source_payload_sha256 AS "sourcePayloadSha256",snapshot_sha256 AS "snapshotSha256",snapshot_text AS "snapshotText"
    FROM upcoming_source_observations WHERE cache_key=${key} AND recorded_at<${cutoff}::timestamptz
    ORDER BY recorded_at DESC,id DESC LIMIT ${limit}`.execute(db)).rows;
}
function validated(row:ObservationRow,kind:'schedule'|'roster',endpoint:string,cutoff:string){
  try {
    if(createHash('sha256').update(row.snapshotText).digest('hex')!==row.snapshotSha256)throw new Error();
    const parsed=JSON.parse(row.snapshotText) as unknown;
    const snapshot=kind==='schedule'?ScheduleCacheDataSchema.parse(parsed):RostersCacheDataSchema.parse(parsed);
    if(row.provider!=='pandascore'||row.endpoint!==endpoint||snapshot.source.endpoint!==endpoint||
      snapshot.source.payloadSha256!==row.sourcePayloadSha256||microseconds(snapshot.source.fetchedAt)!==row.sourceFetchedAt||
      row.sourceFetchedAt>row.recordedAt||row.recordedAt>=microseconds(cutoff))throw new Error();
    return snapshot;
  }catch{throw new UpcomingEvidenceError('invalid_observation');}
}
function reference(row:ObservationRow){
  return {id:row.id,provider:row.provider,endpoint:row.endpoint,sourceFetchedAt:row.sourceFetchedAt,
    recordedAt:row.recordedAt,sourcePayloadSha256:row.sourcePayloadSha256,snapshotSha256:row.snapshotSha256};
}

/** Evidence of seeing an announcement, never a map/identity/lineup certification. */
export class UpcomingEvidenceRepository {
  constructor(private readonly db:Db){}
  async readAsOf(input:unknown):Promise<UpcomingEvidenceReport>{
    const request=UpcomingEvidenceRequestSchema.parse(input);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      if((await sql<{future:boolean}>`SELECT ${request.cutoffAt}::timestamptz>clock_timestamp() AS future`.execute(tx)).rows[0]!.future)
        throw new UpcomingEvidenceError('future_cutoff');
      const rows=await observations(tx,'schedule',request.cutoffAt,HISTORY_LIMIT+1);
      let schedule:UpcomingEvidenceReport['schedule']=null,roster:UpcomingEvidenceReport['roster']=null;
      let examined=0,laterPages=0;
      for(const row of rows.slice(0,HISTORY_LIMIT)){
        examined++;
        const snapshot=ScheduleCacheDataSchema.parse(validated(row,'schedule',SCHEDULE_ENDPOINT,request.cutoffAt));
        if(!unique(snapshot.data.map(m=>m.providerMatchId)))throw new UpcomingEvidenceError('invalid_observation');
        const match=snapshot.data.find(m=>m.providerMatchId===request.providerMatchId);
        if(!match){laterPages++;continue;}
        if(!unique(match.opponents.map(t=>t.providerTeamId)))throw new UpcomingEvidenceError('invalid_observation');
        schedule={observation:{...reference(row),provider:'pandascore'},match};break;
      }
      const reasons:UpcomingEvidenceReason[]=[];
      if(!schedule)reasons.push(rows.length>HISTORY_LIMIT?'schedule_history_limit':'schedule_not_observed');
      else {
        const opponentIds=schedule.match.opponents.map(t=>t.providerTeamId);
        if(opponentIds.length!==2)reasons.push('opponents_incomplete');
        const tournamentId=schedule.match.tournament.providerTournamentId;
        const row=(await observations(tx,`tournament:${tournamentId}`,request.cutoffAt,1))[0];
        if(!row)reasons.push('roster_not_observed');
        else {
          const snapshot=RostersCacheDataSchema.parse(validated(row,'roster',`/tournaments/${tournamentId}/rosters`,request.cutoffAt));
          if(!unique(snapshot.data.map(t=>t.providerTeamId))||snapshot.data.some(t=>!unique(t.players.map(p=>p.providerPlayerId))))
            throw new UpcomingEvidenceError('invalid_observation');
          // Keep every registered player, including substitutes; order is provider opponent order, not map side.
          const teams=opponentIds.flatMap(id=>snapshot.data.filter(t=>t.providerTeamId===id));
          roster={observation:{...reference(row),provider:'pandascore'},teams};
          if(teams.length!==opponentIds.length)reasons.push('opponent_roster_missing');
          if(teams.some(t=>t.players.length===0))reasons.push('empty_roster');
          if(!unique(teams.flatMap(t=>t.players.map(p=>p.providerPlayerId))))reasons.push('roster_player_conflict');
        }
      }
      return UpcomingEvidenceReportSchema.parse({schemaVersion:1,policyVersion:'upcoming-observations-asof-v1',request,
        status:!schedule?'unavailable':reasons.length?'partial':'observed',reasons,scheduleRowsExamined:examined,
        laterSchedulePagesOmittingMatch:schedule?laterPages:0,schedule,roster,
        mapBinding:'not_assessed',lineupVerification:'not_assessed',trainingReady:false,deployable:false});
    });
  }
}
