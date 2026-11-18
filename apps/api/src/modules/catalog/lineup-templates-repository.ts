import {sql,type Db} from '@dota/db';
import {LineupTemplateSchema,LineupTemplateReportSchema,LineupTemplateWriteSchema,type LineupTemplateWrite} from './lineup-templates-contract.js';
type Row={team_id:string;revision:number;owner_user_id:string;owner_login:string;lineup:unknown;confirmed_at:Date;request:unknown};
const record=(r:Row)=>LineupTemplateSchema.parse({teamId:r.team_id,revision:r.revision,lineup:r.lineup,confirmedBy:{id:r.owner_user_id,login:r.owner_login},confirmedAt:r.confirmed_at.toISOString()});
export class LineupTemplateError extends Error{constructor(readonly code:'not_found'|'conflict'|'forbidden'|'invalid'){super(code);}}
export class LineupTemplateRepository{
 constructor(private readonly db:Db){}
 async report(teamId:string){
  if(!(await sql`SELECT id FROM teams WHERE id=${teamId}`.execute(this.db)).rows.length)throw new LineupTemplateError('not_found');
  const rows=(await sql<Row>`SELECT * FROM owner_lineup_templates WHERE team_id=${teamId} ORDER BY revision DESC LIMIT 21`.execute(this.db)).rows;
  return LineupTemplateReportSchema.parse({teamId,current:rows[0]?record(rows[0]):null,history:rows.slice(0,20).map(record),hasMore:rows.length>20});
 }
 async save(actorId:string,teamId:string,input:LineupTemplateWrite){
  return this.db.transaction().execute(async tx=>{
   // Lock the actor as well as the shared team: a concurrent demotion cannot race the write.
   const actor=(await sql<{login:string;account_role:string;is_active:boolean}>`SELECT login,account_role,is_active FROM app_users WHERE id=${actorId}::uuid FOR SHARE`.execute(tx)).rows[0];
   if(!actor?.is_active||actor.account_role!=='owner')throw new LineupTemplateError('forbidden');
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lineup-template-request:'+input.requestId},0))`.execute(tx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'lineup-template-team:'+teamId},0))`.execute(tx);
   const replay=(await sql<Row>`SELECT * FROM owner_lineup_templates WHERE request_id=${input.requestId}::uuid`.execute(tx)).rows[0];
   if(replay){if(replay.team_id!==teamId||JSON.stringify(LineupTemplateWriteSchema.parse(replay.request))!==JSON.stringify(input))throw new LineupTemplateError('conflict');return record(replay);}
   if(!(await sql`SELECT id FROM teams WHERE id=${teamId}`.execute(tx)).rows.length)throw new LineupTemplateError('not_found');
   const ids=input.lineup.map(p=>p.playerId);
   if((await sql`SELECT id FROM players WHERE id IN (${sql.join(ids)})`.execute(tx)).rows.length!==5)throw new LineupTemplateError('invalid');
   const old=(await sql<{revision:number}>`SELECT revision FROM owner_lineup_templates WHERE team_id=${teamId} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
   if((old?.revision??0)!==input.expectedRevision)throw new LineupTemplateError('conflict');
   const row=(await sql<Row>`INSERT INTO owner_lineup_templates(team_id,revision,owner_user_id,owner_login,request_id,lineup,request)
    VALUES(${teamId},${input.expectedRevision+1},${actorId}::uuid,${actor.login},${input.requestId}::uuid,${JSON.stringify(input.lineup)}::jsonb,${JSON.stringify(input)}::jsonb) RETURNING *`.execute(tx)).rows[0]!;
   return record(row);
  });
 }
}
