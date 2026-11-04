import {randomUUID} from 'node:crypto';
import {sql,type Db} from './index.js';
import {RoleProfileBindingSchema,RoleProfileBindingSavedSchema,RoleProfileBindingWriteSchema,RoleProfileObservationSchema,CatalogIdSchema} from '@dota/contracts';
import {readAccountEvidence} from './identity-repository.js';
import {resolveIdentity} from './identity.js';
export class RoleProfileQueryError extends Error{constructor(readonly code:'invalid'|'conflict'){super(code);}}
const empty=()=>({stratzTeamId:null,pandaTournamentId:null,pandaTeamId:null,pandaPlayers:[]});
export class RoleProfileRepository{
  constructor(private readonly db:Db){}
  async binding(owner:string,team:string){
    CatalogIdSchema.parse(team);
    if(!(await sql`SELECT id FROM teams WHERE id=${team}`.execute(this.db)).rows.length)throw new RoleProfileQueryError('invalid');
    const row=(await sql<{binding:unknown;revision:number;recorded_at:Date}>`SELECT binding,revision,recorded_at FROM role_profile_bindings
      WHERE owner_user_id=${owner}::uuid AND team_id=${team} ORDER BY revision DESC LIMIT 1`.execute(this.db)).rows[0];
    return RoleProfileBindingSavedSchema.parse({teamId:team,revision:row?.revision??0,recordedAt:row?.recorded_at.toISOString()??null,binding:row?.binding??empty()});
  }
  async saveBinding(owner:string,team:string,input:unknown){
    const request=RoleProfileBindingWriteSchema.parse(input);CatalogIdSchema.parse(team);
    return this.db.transaction().execute(async tx=>{
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`role-binding:${owner}:${team}`},0))`.execute(tx);
      const replay=(await sql<{team_id:string;binding:unknown;revision:number;recorded_at:Date}>`SELECT team_id,binding,revision,recorded_at
        FROM role_profile_bindings WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
      if(replay){if(replay.team_id!==team||replay.revision!==request.expectedRevision+1||JSON.stringify(RoleProfileBindingSchema.parse(replay.binding))!==JSON.stringify(request.binding))throw new RoleProfileQueryError('conflict');
        return RoleProfileBindingSavedSchema.parse({teamId:team,revision:replay.revision,recordedAt:replay.recorded_at.toISOString(),binding:replay.binding});}
      if(!(await sql`SELECT id FROM teams WHERE id=${team}`.execute(tx)).rows.length)throw new RoleProfileQueryError('invalid');
      const ids=request.binding.pandaPlayers.map(p=>p.playerId);
      if((await sql`SELECT id FROM players WHERE id=ANY(${ids}::bigint[])`.execute(tx)).rows.length!==ids.length)throw new RoleProfileQueryError('invalid');
      const previous=(await sql<{revision:number}>`SELECT revision FROM role_profile_bindings WHERE owner_user_id=${owner}::uuid AND team_id=${team} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
      if((previous?.revision??0)!==request.expectedRevision)throw new RoleProfileQueryError('conflict');
      const revision=request.expectedRevision+1;
      const row=(await sql<{recorded_at:Date}>`INSERT INTO role_profile_bindings(owner_user_id,request_id,team_id,revision,binding)
        VALUES(${owner}::uuid,${request.requestId}::uuid,${team},${revision},${JSON.stringify(request.binding)}::jsonb) RETURNING recorded_at`.execute(tx)).rows[0]!;
      return RoleProfileBindingSavedSchema.parse({teamId:team,revision,recordedAt:row.recorded_at.toISOString(),binding:request.binding});
    });
  }
  async identities(ids:readonly string[]){
    const rows=(await sql<{external_account_id:string}>`SELECT DISTINCT external_account_id FROM player_account_evidence WHERE player_id=ANY(${ids}::bigint[])
      UNION SELECT DISTINCT external_account_id FROM player_external_accounts WHERE player_id=ANY(${ids}::bigint[])`.execute(this.db)).rows;
    const evidence=await readAccountEvidence(this.db,rows.map(r=>r.external_account_id)),now=new Date().toISOString();
    const current=evidence.filter(e=>e.fetchedAt<=now&&(e.knownAt===null||e.knownAt<=now)&&(e.eventAt===null||e.eventAt<=now));
    const resolutions=rows.map(r=>resolveIdentity(current,r.external_account_id,null));
    return ids.map(playerId=>{
      const accountIds=rows.filter((_,i)=>resolutions[i]!.playerId===playerId).map(r=>r.external_account_id);
      const conflict=current.some(e=>e.playerId===playerId&&resolutions.some(r=>r.status==='conflict'&&r.observationIds.includes(e.observationId)));
      return {playerId,accountIds,identityStatus:conflict?'conflict' as const:accountIds.length===1?'verified' as const:'unknown' as const};
    });
  }
  async cache(key:string){
    const row=(await sql<{payload:unknown;fresh:boolean;reason:string|null}>`SELECT payload,(expires_at>clock_timestamp()) IS TRUE AS fresh,
      CASE WHEN lease_until>clock_timestamp() THEN 'refresh_in_progress' WHEN retry_at>clock_timestamp() THEN 'cooldown' ELSE failure_code END AS reason
      FROM role_profile_cache WHERE source_key=${key}`.execute(this.db)).rows[0];
    const parsed=RoleProfileObservationSchema.safeParse(row?.payload);
    const valid=parsed.success&&parsed.data.sourceKey===key&&parsed.data.provider===(key.startsWith('stratz:')?'stratz':'pandascore')&&parsed.data.fetchedAt<=new Date().toISOString();
    return {observation:valid&&parsed.success?parsed.data:null,fresh:valid&&row?.fresh===true,reason:row?.reason??(valid?null:'not_loaded')};
  }
  async claim(key:string){
    if(!/^(stratz:player|pandascore:roster):[1-9]\d{0,18}$/.test(key))throw new RoleProfileQueryError('invalid');
    const token=randomUUID();
    return this.db.transaction().execute(async tx=>{
      await sql`INSERT INTO role_profile_cache(source_key) VALUES(${key}) ON CONFLICT DO NOTHING`.execute(tx);
      const r=await sql`UPDATE role_profile_cache SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '30 seconds'
        WHERE source_key=${key} AND (expires_at IS NULL OR expires_at<=clock_timestamp()) AND lease_until<=clock_timestamp() AND retry_at<=clock_timestamp() RETURNING source_key`.execute(tx);
      return r.rows.length?token:null;
    });
  }
  async publish(key:string,token:string,input:unknown){
    const observation=RoleProfileObservationSchema.parse(input);if(observation.sourceKey!==key)throw new RoleProfileQueryError('invalid');
    await sql`UPDATE role_profile_cache SET payload=${JSON.stringify(observation)}::jsonb,expires_at=clock_timestamp()+interval '1 hour',
      lease_token=NULL,lease_until='-infinity',retry_at='-infinity',failure_code=NULL
      WHERE source_key=${key} AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(this.db);
  }
  async fail(key:string,token:string,code:string,retryMs=60000){
    await sql`UPDATE role_profile_cache SET lease_token=NULL,lease_until='-infinity',failure_code=${code},
      retry_at=clock_timestamp()+${Math.min(86400000,Math.max(60000,retryMs))}*interval '1 millisecond'
      WHERE source_key=${key} AND lease_token=${token}::uuid`.execute(this.db);
  }
  async claimStratz(){
    return this.db.transaction().execute(async tx=>{
      await sql`INSERT INTO role_profile_stratz_quota(singleton) VALUES(true) ON CONFLICT DO NOTHING`.execute(tx);
      await sql`SELECT singleton FROM role_profile_stratz_quota WHERE singleton FOR UPDATE`.execute(tx);
      await sql`UPDATE role_profile_stratz_quota SET requests_used=CASE WHEN day_start<date_trunc('day',clock_timestamp(),'UTC') THEN 0 ELSE requests_used END,
        day_start=date_trunc('day',clock_timestamp(),'UTC') WHERE singleton`.execute(tx);
      const r=(await sql<{wait:string}>`SELECT greatest(0,ceil(extract(epoch FROM greatest(blocked_until,next_request_at,
        CASE WHEN requests_used>=250 THEN day_start+interval '1 day' ELSE clock_timestamp() END)-clock_timestamp())*1000))::bigint::text wait FROM role_profile_stratz_quota WHERE singleton`.execute(tx)).rows[0]!;
      if(Number(r.wait)>0)return Number(r.wait);
      await sql`UPDATE role_profile_stratz_quota SET requests_used=requests_used+1,next_request_at=clock_timestamp()+interval '1200 milliseconds' WHERE singleton`.execute(tx);return 0;
    });
  }
  async blockStratz(ms:number){await sql`UPDATE role_profile_stratz_quota SET blocked_until=greatest(blocked_until,clock_timestamp()+${Math.min(86400000,Math.max(0,ms))}*interval '1 millisecond') WHERE singleton`.execute(this.db);}
}
