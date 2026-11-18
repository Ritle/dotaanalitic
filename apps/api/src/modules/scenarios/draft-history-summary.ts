import {sql,ScenarioError,type Db} from '@dota/db';
import {DraftHistorySummarySchema} from './draft-history-summary-contract.js';
export async function readDraftHistorySummary(db:Db,owner:string,scenarioId:string,revision:number){
  // Read only the linked observation. An unlinked preparation is not this capture's evidence.
  const row=(await sql<{summary:unknown;valid:boolean}>`SELECT
    o.id IS NULL OR (encode(sha256(convert_to(o.evidence_text,'UTF8')),'hex')=o.evidence_sha256
      AND o.owner_user_id=c.owner_user_id AND o.scenario_id=c.scenario_id AND o.revision=c.revision
      AND o.recorded_at<c.decision_cutoff_at
      AND o.evidence_text::jsonb#>>'{selection,scenarioHash}'=c.snapshot_text::jsonb->>'scenarioHash') AS valid,
    CASE WHEN o.id IS NULL THEN jsonb_build_object('status','missing','recordedAt',NULL,'readAt',NULL,
      'maps',NULL,'verifiedMaps',NULL,'excludedMaps',NULL,'reasons',jsonb_build_array('PRE_CUTOFF_HISTORY_OBSERVATION_MISSING'),'forecastStatus','unavailable')
    ELSE jsonb_build_object('status',CASE WHEN o.evidence_text::jsonb#>>'{history,status}'='captured' THEN 'saved' ELSE 'unavailable' END,
      'recordedAt',to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'readAt',to_char(o.read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'maps',CASE WHEN o.evidence_text::jsonb#>>'{history,status}'='captured' THEN jsonb_array_length(o.evidence_text::jsonb#>'{history,maps}') END,
      'verifiedMaps',CASE WHEN o.evidence_text::jsonb#>>'{history,status}'='captured' THEN
        (SELECT count(*)::int FROM jsonb_array_elements(o.evidence_text::jsonb->'outcomes') x WHERE x->>'status'='verified') END,
      'excludedMaps',CASE WHEN o.evidence_text::jsonb#>>'{history,status}'='captured' THEN
        (SELECT count(*)::int FROM jsonb_array_elements(o.evidence_text::jsonb->'outcomes') x WHERE x->>'status'='unavailable') END,
      'reasons',(SELECT COALESCE(jsonb_agg(DISTINCT r),'[]'::jsonb) FROM (
        SELECT jsonb_array_elements_text(o.evidence_text::jsonb->'reasons') r
        UNION SELECT jsonb_array_elements_text(x->'reasons') FROM jsonb_array_elements(o.evidence_text::jsonb->'outcomes') x WHERE x->>'status'='unavailable'
        UNION SELECT CASE WHEN jsonb_array_length(o.evidence_text::jsonb#>'{history,maps}')=0 THEN 'LOCAL_PRO_HISTORY_MISSING' ELSE 'OUTCOME_SOURCE_UNAVAILABLE' END
          WHERE o.evidence_text::jsonb#>>'{history,status}'='unavailable' AND jsonb_array_length(o.evidence_text::jsonb->'reasons')=0
      ) codes),'forecastStatus','unavailable') END AS summary
    FROM owner_draft_captures c
    LEFT JOIN owner_draft_history_links l ON l.capture_id=c.id
    LEFT JOIN owner_draft_history_observations o ON o.id=l.observation_id
    WHERE c.owner_user_id=${owner}::uuid AND c.scenario_id=${scenarioId}::uuid AND c.revision=${revision}`.execute(db)).rows[0];
  if(!row)throw new ScenarioError('NOT_FOUND');
  if(!row.valid)throw Error('draft_history_summary_integrity');
  return DraftHistorySummarySchema.parse(row.summary);
}
