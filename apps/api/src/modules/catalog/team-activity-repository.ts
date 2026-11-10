import {sql,type Db} from '@dota/db';
import {ActivityWriteSchema,ActivityRecordSchema,ActivityReportSchema,TeamDirectorySchema,type ActivityWrite,type TeamDirectoryQuery} from './team-activity-contract.js';
type Row={team_id:string;revision:number;status:string;basis:string;source_url:string|null;note:string;checked_at:Date;effective_at:Date|null;recorded_at:Date;request:unknown};
const record=(r:Row)=>ActivityRecordSchema.parse({revision:r.revision,status:r.status,basis:r.basis,sourceUrl:r.source_url,note:r.note,checkedAt:r.checked_at.toISOString(),effectiveAt:r.effective_at?.toISOString()??null,recordedAt:r.recorded_at.toISOString()});
export class TeamActivityError extends Error{constructor(readonly code:'not_found'|'conflict'|'invalid'){super(code);}}
export class TeamActivityRepository{
 constructor(private readonly db:Db){}
 private async exists(id:string){return (await sql`SELECT id FROM teams WHERE id=${id}`.execute(this.db)).rows.length>0;}
 async report(owner:string,id:string){
  if(!await this.exists(id))throw new TeamActivityError('not_found');
  const rows=(await sql<Row>`SELECT * FROM team_activity_reviews WHERE owner_user_id=${owner}::uuid AND team_id=${id} ORDER BY revision DESC LIMIT 21`.execute(this.db)).rows;
  return ActivityReportSchema.parse({teamId:id,current:rows[0]?record(rows[0]):null,history:rows.slice(0,20).map(record),hasMore:rows.length>20,computedAt:new Date().toISOString()});
 }
 async save(owner:string,id:string,input:ActivityWrite){
  if(Date.parse(input.checkedAt)>Date.now())throw new TeamActivityError('invalid');
  return this.db.transaction().execute(async tx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-request:${owner}:${input.requestId}`},0))`.execute(tx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-team:${owner}:${id}`},0))`.execute(tx);
   const replay=(await sql<Row>`SELECT * FROM team_activity_reviews WHERE owner_user_id=${owner}::uuid AND request_id=${input.requestId}::uuid`.execute(tx)).rows[0];
   if(replay){if(replay.team_id!==id||JSON.stringify(ActivityWriteSchema.parse(replay.request))!==JSON.stringify(input))throw new TeamActivityError('conflict');return record(replay);}
   if(!(await sql`SELECT id FROM teams WHERE id=${id}`.execute(tx)).rows.length)throw new TeamActivityError('not_found');
   const old=(await sql<{revision:number}>`SELECT revision FROM team_activity_reviews WHERE owner_user_id=${owner}::uuid AND team_id=${id} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
   if((old?.revision??0)!==input.expectedRevision)throw new TeamActivityError('conflict');
   const row=(await sql<Row>`INSERT INTO team_activity_reviews(owner_user_id,team_id,request_id,revision,status,basis,source_url,note,checked_at,effective_at,request)
    VALUES(${owner}::uuid,${id},${input.requestId}::uuid,${input.expectedRevision+1},${input.status},${input.basis},${input.sourceUrl},${input.note},${input.checkedAt},${input.effectiveAt},${JSON.stringify(input)}::jsonb) RETURNING *`.execute(tx)).rows[0]!;
   return record(row);
  });
 }
 async search(owner:string,input:TeamDirectoryQuery){
  const {activityView,...filters}=input;
  const rows=(await sql<{id:string;name:string;secondary:string|null;synced_at:Date|null;updated_at:Date;activity_status:string}>`
   SELECT t.id::text,t.name,t.tag AS secondary,t.synced_at,t.updated_at,coalesce(a.status,'unknown') AS activity_status FROM teams t
   LEFT JOIN LATERAL (SELECT status FROM team_activity_reviews WHERE owner_user_id=${owner}::uuid AND team_id=t.id ORDER BY revision DESC LIMIT 1) a ON true
   WHERE (${filters.query}='' OR t.id::text=${filters.query} OR strpos(lower(t.name),lower(${filters.query}))>0 OR strpos(lower(coalesce(t.tag,'')),lower(${filters.query}))>0)
   AND (${activityView}='all' OR (${activityView}='current' AND coalesce(a.status,'unknown')<>'inactive') OR (${activityView}='archived' AND a.status='inactive'))
   ORDER BY lower(t.name),t.id LIMIT ${filters.limit+1} OFFSET ${filters.offset}`.execute(this.db)).rows;
  return TeamDirectorySchema.parse({kind:'teams',activityView,filters,items:rows.slice(0,filters.limit).map(r=>({id:r.id,name:r.name,secondary:r.secondary,syncedAt:r.synced_at?.toISOString()??null,metadataUpdatedAt:r.updated_at.toISOString(),activityStatus:r.activity_status})),hasMore:rows.length>filters.limit,source:'local_catalog',computedAt:new Date().toISOString(),warnings:['OWNER_REVIEWED_ACTIVITY','UNKNOWN_ACTIVITY_REMAINS_VISIBLE']});
 }
}
