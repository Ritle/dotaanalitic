import {randomUUID} from 'node:crypto';
import {sql,type Db} from './index.js';
import {RosterCatalogueBindingSchema,type RosterCatalogueApply,type RosterCatalogueBinding} from '@dota/contracts';
import {canonicalContextJson} from './temporal.js';
import {RoleProfileRepository} from './role-profile-repository.js';
export class RosterCatalogueError extends Error{constructor(readonly code:'invalid'|'conflict'|'source_unavailable'|'source_changed'){super(code);}}
export class RosterCatalogueRepository{
 constructor(private readonly db:Db){}
 async prepareLease(owner:string,team:string){const token=randomUUID();return this.db.transaction().execute(async tx=>{
  await sql`INSERT INTO roster_catalogue_operations(owner_user_id,provider_team_id) VALUES(${owner}::uuid,${team}) ON CONFLICT DO NOTHING`.execute(tx);
  const r=await sql`UPDATE roster_catalogue_operations SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '3 minutes'
   WHERE owner_user_id=${owner}::uuid AND provider_team_id=${team} AND lease_until<=clock_timestamp() RETURNING provider_team_id`.execute(tx);
  if(!r.rows.length)throw new RosterCatalogueError('conflict');return token;
 });}
 async releasePreparation(owner:string,team:string,token:string){await sql`UPDATE roster_catalogue_operations SET lease_token=NULL,lease_until='-infinity'
  WHERE owner_user_id=${owner}::uuid AND provider_team_id=${team} AND lease_token=${token}::uuid`.execute(this.db);}
 async checkPreparation(owner:string,team:string,token:string){if(!(await sql`SELECT provider_team_id FROM roster_catalogue_operations
  WHERE owner_user_id=${owner}::uuid AND provider_team_id=${team} AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(this.db)).rows.length)throw new RosterCatalogueError('conflict');}
 async cached(key:string){return (await sql<{observation:unknown;fresh:boolean}>`SELECT observation,(expires_at>clock_timestamp()) IS TRUE fresh FROM roster_catalogue_cache WHERE source_key=${key}`.execute(this.db)).rows[0]??null;}
 async claim(key:string){const token=randomUUID();return this.db.transaction().execute(async tx=>{
  await sql`INSERT INTO roster_catalogue_cache(source_key) VALUES(${key}) ON CONFLICT DO NOTHING`.execute(tx);
  const r=await sql`UPDATE roster_catalogue_cache SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '90 seconds'
   WHERE source_key=${key} AND (expires_at IS NULL OR expires_at<=clock_timestamp()) AND lease_until<=clock_timestamp() AND retry_at<=clock_timestamp() RETURNING source_key`.execute(tx);
  return r.rows.length?token:null;
 });}
 async publish(key:string,token:string,observation:{source:{fetchedAt:string}}){const r=await sql`UPDATE roster_catalogue_cache SET observation=${JSON.stringify(observation)}::jsonb,
  expires_at=${observation.source.fetchedAt}::timestamptz+interval '1 hour',lease_token=NULL,lease_until='-infinity',retry_at='-infinity'
  WHERE source_key=${key} AND lease_token=${token}::uuid AND lease_until>clock_timestamp() RETURNING source_key`.execute(this.db);
  if(!r.rows.length)throw new RosterCatalogueError('source_unavailable');}
 async fail(key:string,token:string){await sql`UPDATE roster_catalogue_cache SET lease_token=NULL,lease_until='-infinity',retry_at=clock_timestamp()+interval '1 minute'
  WHERE source_key=${key} AND lease_token=${token}::uuid`.execute(this.db);}
 async revision(owner:string,providerTeamId:string){return (await sql<{revision:number}>`SELECT revision FROM expected_roster_catalogue_bindings
  WHERE owner_user_id=${owner}::uuid AND provider_team_id=${providerTeamId} ORDER BY revision DESC LIMIT 1`.execute(this.db)).rows[0]?.revision??0;}
 async latest(owner:string,providerTeamId:string){const r=(await sql<{binding:unknown}>`SELECT binding FROM expected_roster_catalogue_bindings
  WHERE owner_user_id=${owner}::uuid AND provider_team_id=${providerTeamId} ORDER BY revision DESC LIMIT 1`.execute(this.db)).rows[0];
  if(!r)return null;return this.decorate(RosterCatalogueBindingSchema.parse(r.binding));}
 async replay(owner:string,request:RosterCatalogueApply){const r=(await sql<{request:unknown;binding:unknown}>`SELECT request,binding FROM expected_roster_catalogue_bindings
  WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(this.db)).rows[0];
  if(!r)return null;if(canonicalContextJson(r.request)!==canonicalContextJson(request))throw new RosterCatalogueError('conflict');
  return this.decorate(RosterCatalogueBindingSchema.parse(r.binding));}
 async save(owner:string,request:RosterCatalogueApply,binding:RosterCatalogueBinding){return this.db.transaction().execute(async tx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`catalogue-binding:${owner}:${request.providerTeamId}`},0))`.execute(tx);
  const repo=new RosterCatalogueRepository(tx),replay=await repo.replay(owner,request);if(replay)return replay;
  if(await repo.revision(owner,request.providerTeamId)!==request.expectedRevision)throw new RosterCatalogueError('conflict');
  const value=RosterCatalogueBindingSchema.parse(binding);
  await sql`INSERT INTO expected_roster_catalogue_bindings(owner_user_id,request_id,provider_team_id,team_id,revision,request,binding)
   VALUES(${owner}::uuid,${request.requestId}::uuid,${request.providerTeamId},${value.teamId},${value.revision},${JSON.stringify(request)}::jsonb,${JSON.stringify(value)}::jsonb)`.execute(tx);
  return repo.decorate(value);
 });}
 private async decorate(binding:RosterCatalogueBinding){const ids=binding.players.map(p=>p.playerId),now=new Date().toISOString();
  const counts=(await sql<{player_id:string;n:number}>`SELECT mp.player_id,count(DISTINCT m.id)::int n FROM match_players mp JOIN matches m ON m.id=mp.match_id
   WHERE mp.player_id=ANY(${ids}::bigint[]) AND m.is_pro IS TRUE AND m.ingest_state<>'conflict' AND m.radiant_win IS NOT NULL AND m.duration_seconds>0
   AND m.started_at<${now} AND m.started_at+make_interval(secs=>m.duration_seconds)<=${now} GROUP BY mp.player_id`.execute(this.db)).rows;
  const identities=await new RoleProfileRepository(this.db).identities(ids);
  return RosterCatalogueBindingSchema.parse({...binding,players:binding.players.map(p=>({...p,proMaps:counts.find(c=>c.player_id===p.playerId)?.n??0,
   identityStatus:identities.find(i=>i.playerId===p.playerId)?.identityStatus??'unknown'})),usable:identities.every(p=>p.identityStatus==='verified')});
 }
}
