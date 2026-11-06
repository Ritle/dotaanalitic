import {Tier1ScopeWriteSchema,Tier1ScopeSavedSchema,Tier1ScopeListSchema,Tier1ScopeQuerySchema} from '@dota/contracts';
import {sql,type Db} from './index.js';
import {registryHash,registrySha} from './v1-registry.js';
import {ScenarioError} from './scenario-repository.js';
type Row={record_text:string;record_sha256:string;request_hash:string};
const saved=(row:Row)=>{
 if(registrySha(row.record_text)!==row.record_sha256)throw Error('tier1_scope_integrity');
 const parsed=Tier1ScopeSavedSchema.safeParse({record:JSON.parse(row.record_text),sha256:row.record_sha256});
 if(!parsed.success)throw Error('tier1_scope_integrity');const value=parsed.data;
 if(registryHash(value.record.request)!==row.request_hash)throw Error('tier1_scope_integrity');return value;
};
export class Tier1ScopeRepository{
 constructor(private readonly db:Db){}
 async list(owner:string,input:unknown){
  const q=Tier1ScopeQuerySchema.parse(input);
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
   await sql`SET TRANSACTION READ ONLY`.execute(tx);
   const rows=(await sql<Row>`SELECT * FROM (SELECT DISTINCT ON(scope_id) * FROM owner_tier1_scopes
    WHERE owner_user_id=${owner}::uuid ORDER BY scope_id,revision DESC) latest WHERE enabled
    ORDER BY recorded_at DESC,scope_id LIMIT 21 OFFSET ${q.offset}`.execute(tx)).rows;
   const providerId=q.localLeagueId?(await sql<{id:string|null}>`SELECT CASE WHEN opendota_league_id>0 THEN opendota_league_id::text END id FROM leagues WHERE id=${q.localLeagueId}::bigint`.execute(tx)).rows[0]?.id??null:null;
   const clock=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`.execute(tx)).rows[0]!.at;
   return Tier1ScopeListSchema.parse({items:rows.slice(0,20).map(saved),hasMore:rows.length>20,
    context:{localLeagueId:q.localLeagueId??null,providerLeagueId:providerId,at:q.at??null},source:'owner_reviewed_catalogue',computedAt:clock});
  });
 }
 async write(owner:string,input:unknown){
  const request=Tier1ScopeWriteSchema.parse(input),hash=registryHash(request);
  return this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'owner-tier1-scopes:'+owner},0))`.execute(tx);
   const old=(await sql<Row>`SELECT * FROM owner_tier1_scopes WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
   if(old){if(old.request_hash!==hash)throw Error('tier1_scope_request_conflict');return saved(old);}
   const priorRow=(await sql<Row>`SELECT * FROM owner_tier1_scopes WHERE owner_user_id=${owner}::uuid AND scope_id=${request.scopeId}::uuid ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
   const prior=priorRow?saved(priorRow):null;
   if((prior?.record.revision??0)!==request.expectedRevision)throw new ScenarioError('CONFLICT');
   if(prior&&prior.record.request.scope.leagueId!==request.scope.leagueId)throw Error('tier1_scope_new_league');
   const at=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`.execute(tx)).rows[0]!.at;
   const text=JSON.stringify({format:'owner-tier1-scope-v1',request,revision:request.expectedRevision+1,previousSha256:prior?.sha256??null,recordedAt:at});
   const row=(await sql<Row>`INSERT INTO owner_tier1_scopes(owner_user_id,scope_id,revision,request_id,request_hash,enabled,record_text,record_sha256)
    VALUES(${owner}::uuid,${request.scopeId}::uuid,${request.expectedRevision+1},${request.requestId}::uuid,${hash},${request.enabled},${text},${registrySha(text)}) RETURNING *`.execute(tx)).rows[0]!;
   return saved(row);
  });
 }
}
