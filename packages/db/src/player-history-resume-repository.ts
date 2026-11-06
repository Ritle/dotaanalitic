import {CatalogIdSchema,PlayerHistoryReportSchema,PlayerHistorySourceAuditSchema,PlayerHistoryReferenceIdsSchema} from '@dota/contracts';
import {sql,type Db} from './index.js';
import {PlayerHistoryRepository,type PlayerHistoryRow} from './player-history-repository.js';
export class PlayerHistoryResumeError extends Error{}
export function historyResumeScope(row:PlayerHistoryRow){
 if(['queued','running'].includes(row.status))return [];
 const report=PlayerHistoryReportSchema.safeParse(row.report);
 const scope=row.operation==='evidence_resume'?row.scope_map_ids:report.success?report.data.maps.filter(m=>['accepted','duplicate'].includes(m.status)).map(m=>m.matchId):[];
 if(!Array.isArray(scope)||scope.length>50||scope.some(id=>!CatalogIdSchema.safeParse(id).success))return [];
 return [...new Set(scope)].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
}
export class PlayerHistoryResumeRepository{
 constructor(readonly db:Db){}
 async root(row:PlayerHistoryRow){
  const root=row.operation==='evidence_resume'&&row.parent_run_id?await new PlayerHistoryRepository(this.db).get(row.parent_run_id):row;
  if(!root||root.owner_user_id!==row.owner_user_id||root.operation!=='import'||root.lineup_key!==row.lineup_key||!historyResumeScope(root).length)throw new PlayerHistoryResumeError('resume_source_unavailable');
  return root;
 }
 async projection(root:PlayerHistoryRow,matchId:string){
  const audit=PlayerHistorySourceAuditSchema.safeParse(root.source_audit);
  const sources=audit.success?audit.data.sources:[];
  const matches=sources.filter(s=>s.endpoint==='/matches/'+matchId);if(matches.length!==1)throw new PlayerHistoryResumeError('stored_source_unavailable');
  const source=matches[0]!;
  const r=(await sql<{receiptId:string;payloadSha256:string;fetchedAt:Date;eventAt:Date;status:string;projection:unknown;isPro:boolean;metrics:unknown}>`
   SELECT r.id::text "receiptId",r.payload_sha256 "payloadSha256",r.fetched_at "fetchedAt",r.event_at "eventAt",r.status,r.source_payload projection,m.is_pro "isPro",q.metrics
   FROM provider_ingest_receipts r JOIN matches m ON m.id=r.provider_match_id::bigint
   JOIN match_quality_assessments q ON q.metrics->>'receipt_id'=r.id::text
   WHERE r.provider='opendota' AND r.provider_match_id=${matchId} AND r.payload_sha256=${source.payloadSha256} AND r.fetched_at=${source.fetchedAt}
   AND r.status IN ('accepted','partial') AND m.is_pro IS TRUE AND m.ingest_state<>'conflict'
   ORDER BY r.id DESC LIMIT 1`.execute(this.db)).rows[0];
  if(!r)throw new PlayerHistoryResumeError('stored_source_unavailable');
  const metrics=PlayerHistoryReferenceIdsSchema.parse(r.metrics);
  const references=(await sql<{id:string;endpoint:string;payload:unknown;payloadSha256:string;fetchedAt:Date}>`
   SELECT id::text,endpoint,source_payload payload,payload_sha256 "payloadSha256",fetched_at "fetchedAt" FROM provider_reference_snapshots
   WHERE provider='opendota' AND id IN (${metrics.hero_reference_id}::bigint,${metrics.league_reference_id}::bigint)`.execute(this.db)).rows;
  const reference=(id:string,endpoint:string)=>{const ref=references.find(r=>r.id===id&&r.endpoint===endpoint);if(!ref)throw new PlayerHistoryResumeError('stored_reference_unavailable');return {...ref,fetchedAt:ref.fetchedAt.toISOString()};};
  return {...r,matchId,fetchedAt:r.fetchedAt.toISOString(),eventAt:r.eventAt.toISOString(),heroes:reference(metrics.hero_reference_id,'/heroes'),leagues:reference(metrics.league_reference_id,'/leagues')};
 }
 async accountOrder(accounts:readonly string[]){
  if(!accounts.length)return [];
  // Untried profiles get a turn before cached private/failed ones on the next bounded job.
  return (await sql<{id:string}>`SELECT a.id FROM unnest(${accounts}::text[]) a(id) LEFT JOIN roster_catalogue_cache c ON c.source_key='player:'||a.id
   ORDER BY CASE WHEN c.retry_at>clock_timestamp() OR c.lease_until>clock_timestamp() THEN 2 WHEN c.observation IS NULL THEN 0 ELSE 1 END,
    c.expires_at NULLS FIRST,a.id::bigint`.execute(this.db)).rows.map(r=>r.id);
 }
 async record(runId:string,attempt:number,matchId:string,receiptId:string,parent:{parentReceiptId:string;parentHeroReferenceId:string;parentLeagueReferenceId:string;derivedAt:string},sha:string){
  await sql`INSERT INTO player_history_projection_replays(run_id,attempt,match_id,parent_receipt_id,derived_receipt_id,parent_hero_reference_id,parent_league_reference_id,derived_sha256,derived_at)
   VALUES(${runId}::uuid,${attempt},${matchId},${parent.parentReceiptId},${receiptId},${parent.parentHeroReferenceId},${parent.parentLeagueReferenceId},${sha},${parent.derivedAt})
   ON CONFLICT DO NOTHING`.execute(this.db);
 }
}
