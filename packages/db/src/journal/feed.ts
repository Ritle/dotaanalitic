import {V1RuntimeRequestSchema,V1ForecastOutcomeSchema} from '@dota/contracts';
import {V1JournalFeedSchema,V1JournalFeedCursorSchema,V1JournalFeedSnapshotSchema} from '../../../contracts/dist/journal/feed.js';
import {sql,type Db} from '../index.js';
import {registryHash,registrySha} from '../v1-registry.js';
import {forecastOutcomeFingerprint} from '../v1-forecast-outcomes.js';
import {readLifecycleRow} from '../v1-target-lifecycle.js';
import {readScheduledLifecycleRow} from '../v1-scheduled-lifecycle.js';
type LifecycleRow={event_text:string;event_sha256:string;request_hash:string};
// Full immutable bytes still pass SHA verification. The feed needs no recursive validation
// or copying of the potentially large code/source/feature manifests on every page read.
/** Current owner feed. Reads committed calculations; never creates reports or outcome revisions. */
export async function readV1JournalFeed(db:Db,owner:string,cursorInput:unknown=null){
  V1RuntimeRequestSchema.shape.requestId.parse(owner);
  const cursor=V1JournalFeedCursorSchema.nullable().parse(cursorInput);
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    // Existing verifier takes FOR SHARE locks; no INSERT/UPDATE is performed by this feed.
    await sql`SET LOCAL statement_timeout='15s'`.execute(tx);
    const readAt=new Date().toISOString();
    const rows=(await sql<{prediction_id:string;snapshot_text:string;snapshot_sha256:string;request_hash:string}>
      `SELECT s.prediction_id,s.snapshot_text,s.snapshot_sha256,s.request_hash FROM v1_runtime_snapshots s
       JOIN prediction_runs p ON p.id=s.prediction_id WHERE s.owner_user_id=${owner}::uuid
       AND (${cursor?.createdAt??null}::timestamptz IS NULL OR (p.created_at,s.prediction_id)<(${cursor?.createdAt??null}::timestamptz,${cursor?.id??null}::uuid))
       ORDER BY p.created_at DESC,s.prediction_id DESC LIMIT 51`.execute(tx)).rows;
    const items=[];
    for(const row of rows.slice(0,50)){
      if(registrySha(row.snapshot_text)!==row.snapshot_sha256)throw Error('journal_feed_integrity');
      const s=V1JournalFeedSnapshotSchema.parse(JSON.parse(row.snapshot_text));
      if(registryHash(s.request)!==row.request_hash)throw Error('journal_feed_integrity');
      const target=s.request.purpose==='real_map'?s.request.realTarget:null;
      let status:'eligible'|'what_if'|'unavailable'|'pending_verification'|'excluded'|'cancelled'=
        s.status==='unavailable'?'unavailable':target?'pending_verification':'what_if';
      let actualWinner:'A'|'B'|null=null,checkedAt:string|null=null,sourceChangedSinceRefresh=false;
      let reasons=[...s.reasons];
      if(target){
        const latest=(await sql<{result_text:string;result_sha256:string;content_sha256:string}>
          `SELECT result_text,result_sha256,content_sha256 FROM v1_forecast_outcome_revisions
           WHERE prediction_id=${row.prediction_id}::uuid ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        if(latest){
          const saved=V1ForecastOutcomeSchema.parse(JSON.parse(latest.result_text));
          if(registrySha(latest.result_text)!==latest.result_sha256||forecastOutcomeFingerprint(saved)!==latest.content_sha256||saved.predictionId!==row.prediction_id)throw Error('journal_feed_integrity');
          const fresh=V1ForecastOutcomeSchema.parse((await sql<{result:unknown}>`SELECT verify_v1_forecast_outcome(${row.prediction_id}::uuid,${saved.matchId}::bigint,${readAt}::timestamptz) AS result`.execute(tx)).rows[0]!.result);
          sourceChangedSinceRefresh=forecastOutcomeFingerprint(fresh)!==latest.content_sha256;
          checkedAt=saved.checkedAt;reasons=[...reasons,...saved.reasons];
          if(s.status==='done'&&saved.status==='linked'){
            status=saved.prospectiveEligible?'eligible':'excluded';actualWinner=saved.outcome!.teamAWon?'A':'B';
          }
        }
        const lifecycle=target.provider==='pandascore'
          ?(await sql<LifecycleRow>`SELECT event_text,event_sha256,request_hash FROM v1_scheduled_lifecycle WHERE owner_user_id=${owner}::uuid AND provider_match_id=${target.providerMatchId}::bigint ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0]
          :(await sql<LifecycleRow>`SELECT event_text,event_sha256,request_hash FROM v1_target_lifecycle WHERE owner_user_id=${owner}::uuid AND provider_series_id=${target.providerSeriesId}::bigint AND map_number=1 ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        if(lifecycle){
          const state=target.provider==='pandascore'?readScheduledLifecycleRow(lifecycle):readLifecycleRow(lifecycle);
          if(state.event.request.action==='cancelled'){
            // Only cancellations need the cross-recalculation binding check. Materialize the small
            // target once per bound snapshot instead of repeatedly parsing large code manifests.
            const scheduleBound=target.provider==='pandascore'&&(await sql`SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid AND provider_match_id=${target.providerMatchId}::bigint LIMIT 1`.execute(tx)).rows.length>0;
            const binding=scheduleBound||(await sql`WITH linked AS MATERIALIZED (
              SELECT DISTINCT prediction_id FROM v1_forecast_outcome_revisions WHERE result_text::jsonb->>'status'='linked'),
              targets AS MATERIALIZED (SELECT r.snapshot_text::jsonb#>'{request,realTarget}' AS t FROM linked l
                JOIN v1_runtime_snapshots r ON r.prediction_id=l.prediction_id WHERE r.owner_user_id=${owner}::uuid)
              SELECT 1 FROM targets WHERE t->>'provider'=${target.provider} AND t->>'mapNumber'='1'
                AND CASE WHEN ${target.provider}='pandascore' THEN t->>'providerMatchId' ELSE t->>'providerSeriesId' END=
                  ${target.provider==='pandascore'?target.providerMatchId:target.providerSeriesId} LIMIT 1`.execute(tx)).rows.length>0;
            if(!binding){status='cancelled';actualWinner=null;}
          }
        }
      }
      items.push({predictionId:row.prediction_id,requestId:s.request.requestId,createdAt:s.createdAt,
        scenario:{id:s.scenario.id,revision:s.scenario.revision,title:s.scenario.input.title,teamAId:s.scenario.input.teamAId,teamBId:s.scenario.input.teamBId},
        target:target?(target.provider==='pandascore'?{provider:target.provider,providerMatchId:target.providerMatchId,mapNumber:target.mapNumber,targetRequestId:target.targetRequestId,targetSha256:target.targetSha256}:{provider:target.provider,providerSeriesId:target.providerSeriesId,mapNumber:target.mapNumber}):null,
        expectedLineups:{teamA:s.scenario.input.lineupA.map(p=>p.playerId),teamB:s.scenario.input.lineupB.map(p=>p.playerId)},
        probability:s.teamAWinProbability,calculationStatus:s.status,status,actualWinner,sourceChangedSinceRefresh,checkedAt,reasons});
    }
    const last=items.at(-1);
    return V1JournalFeedSchema.parse({readAt,items,nextCursor:rows.length>50&&last?{createdAt:last.createdAt,id:last.predictionId}:null});
  });
}
