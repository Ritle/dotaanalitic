import {createHash} from 'node:crypto';
import {CorpusQualityRequestSchema,CorpusQualityRowSchema,type CorpusQualityRow} from '@dota/contracts';
import {sql,type Db} from './index.js';
import {canonicalContextJson} from './temporal.js';

const dimensions=['outcome','players','heroes','teams','series','timeline'] as const;
function summarize(rows:CorpusQualityRow[]){
  const counts=Object.fromEntries(dimensions.map(d=>[d,Object.fromEntries(
    (d==='timeline'?['unknown','structurally_inconsistent','missing','verified']:['eligible','ineligible','unknown'])
      .map(status=>[status,rows.filter(r=>r.quality[d]===status).length]))]));
  const codes=[...new Set(rows.flatMap(r=>r.anomalies))].sort();
  return {maps:rows.length,assessedMaps:rows.filter(r=>r.assessment!==null).length,
    linkedReceiptMaps:rows.filter(r=>r.assessment?.receipt!=null).length,
    canonicalConflictMaps:rows.filter(r=>r.ingestState==='conflict').length,dimensions:counts,
    anomalies:Object.fromEntries(codes.map(code=>[code,rows.filter(r=>r.anomalies.includes(code)).length]))};
}

/** Current stored import assessments only: neither historical context nor training eligibility. */
export class CorpusQualityRepository {
  constructor(private readonly db:Db){}
  async report(input:unknown){
    const request=CorpusQualityRequestSchema.parse(input);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      const clock=(await sql<{computedAt:string;future:boolean}>`SELECT
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "computedAt",
        ${request.toAt}::timestamptz>clock_timestamp() AS future`.execute(tx)).rows[0]!;
      if(clock.future)throw new Error('future_window');
      const raw=(await sql<{item:unknown}>`SELECT jsonb_build_object(
        'matchId',m.id::text,'startedAt',to_char(m.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'syncedAt',to_char(m.synced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'dataRevision',m.data_revision::text,'ingestState',m.ingest_state,'canonicalPatchId',m.patch_id::text,'leagueId',m.league_id::text,
        'providerPatchId',CASE WHEN q.metrics->>'provider_patch_id' ~ '^[0-9]{1,10}$' THEN q.metrics->>'provider_patch_id' ELSE NULL END,
        'quality',jsonb_build_object('outcome',coalesce(q.outcome_status,'unknown'),'players',coalesce(q.player_status,'unknown'),
          'heroes',coalesce(q.final_heroes_status,'unknown'),'teams',coalesce(q.organization_status,'unknown'),
          'series',coalesce(q.series_status,'unknown'),'timeline',coalesce(q.draft_timeline_status,'unknown')),
        'anomalies',coalesce(q.anomalies,'[]'::jsonb),
        'assessment',CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object('id',q.id::text,'validatorVersion',q.validator_version,
          'assessedAt',to_char(q.assessed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'sourceSnapshotId',q.source_snapshot_id::text,'provider',s.provider,
          'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id::text,'payloadSha256',r.payload_sha256,
            'fetchedAt',to_char(r.fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'normalizerVersion',r.normalizer_version) END) END) AS item
        FROM matches m
        LEFT JOIN LATERAL (SELECT * FROM match_quality_assessments WHERE match_id=m.id
          ORDER BY assessed_at DESC,id DESC LIMIT 1) q ON true
        LEFT JOIN match_source_snapshots s ON s.id=q.source_snapshot_id AND s.match_id=m.id
        LEFT JOIN provider_ingest_receipts r ON r.id::text=q.metrics->>'receipt_id' AND r.canonical_match_id=m.id
          AND r.provider_match_id=m.id::text AND r.provider=s.provider AND r.payload_sha256=s.payload_sha256
          AND s.provider_match_id=r.provider_match_id
        WHERE m.is_pro IS TRUE AND m.started_at>=${request.fromAt}::timestamptz AND m.started_at<${request.toAt}::timestamptz
        ORDER BY m.started_at,m.id LIMIT 5001`.execute(tx)).rows;
      if(raw.length>5000)return {status:'unavailable' as const,reason:'WINDOW_TOO_LARGE' as const,maxMaps:5000,
        request,computedAt:clock.computedAt,fingerprint:null,trainingReady:false,deployable:false};
      const maps=raw.map(r=>CorpusQualityRowSchema.parse(r.item));
      const strata=(key:(row:CorpusQualityRow)=>string)=>[...new Set(maps.map(key))].sort().map(value=>({value,
        ...summarize(maps.filter(r=>key(r)===value))}));
      const body={policyVersion:'current-pro-import-quality-v1',scope:'current_stored_assessments',request,maps,
        summary:summarize(maps),strata:{canonicalPatch:strata(r=>r.canonicalPatchId??'unknown'),
          providerPatch:strata(r=>`${r.assessment?.provider??'unknown'}:${r.providerPatchId??'unknown'}`),
          league:strata(r=>r.leagueId??'unknown'),period:strata(r=>r.startedAt.slice(0,7))},
        historicalAvailability:'not_assessed',trainingReady:false,deployable:false};
      return {status:'complete' as const,computedAt:clock.computedAt,...body,
        fingerprint:createHash('sha256').update(canonicalContextJson(body)).digest('hex')};
    });
  }
}
