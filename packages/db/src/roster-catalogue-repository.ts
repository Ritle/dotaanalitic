import {randomUUID} from 'node:crypto';
import {sql,type Db} from './index.js';
import {RosterCatalogueBindingSchema,type RosterCatalogueApply,type RosterCatalogueBinding} from '@dota/contracts';
import {canonicalContextJson} from './temporal.js';
import {RoleProfileRepository} from './role-profile-repository.js';
import {PlayerCatalogueRepository} from './player-catalogue-repository.js';
import {appendAliasEvidence} from './identity-repository.js';
export class RosterCatalogueError extends Error{constructor(readonly code:'invalid'|'conflict'|'source_unavailable'|'source_changed'){super(code);}}
export class RosterCatalogueRepository{
 constructor(private readonly db:Db){}
 async openDotaTeam(id:string,name:string,tag:string|null,fetchedAt:string){return this.db.transaction().execute(async tx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`catalogue-team:opendota:${id}`},0))`.execute(tx);
  const existing=(await sql<{id:string;name:string}>`SELECT id,name FROM teams WHERE opendota_team_id=${id}`.execute(tx)).rows[0];if(existing)return existing;
  return (await sql<{id:string;name:string}>`INSERT INTO teams(opendota_team_id,name,tag,synced_at) VALUES(${id},${name},${tag},${fetchedAt}) ON CONFLICT(opendota_team_id) DO UPDATE SET opendota_team_id=EXCLUDED.opendota_team_id RETURNING id,name`.execute(tx)).rows[0]!;
 });}
 async pandaTeam(id:string,name:string,source:{fetchedAt:string;payloadSha256:string}){return this.db.transaction().execute(async tx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-team:pandascore:${id}`},0))`.execute(tx);
  const existing=(await sql<{id:string;name:string}>`SELECT t.id,t.name FROM provider_team_catalogue p JOIN teams t ON t.id=p.team_id
   WHERE p.provider='pandascore' AND p.external_team_id=${id}`.execute(tx)).rows[0];if(existing)return existing;
  const team=(await sql<{id:string;name:string}>`INSERT INTO teams(name,synced_at) VALUES(${name},${source.fetchedAt}) RETURNING id,name`.execute(tx)).rows[0]!;
  await sql`INSERT INTO provider_team_catalogue(provider,external_team_id,team_id,source) VALUES('pandascore',${id},${team.id},${JSON.stringify(source)}::jsonb)`.execute(tx);return team;
 });}
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
  if(!r)return null;return this.decorate(owner,RosterCatalogueBindingSchema.parse(r.binding));}
 async replay(owner:string,request:RosterCatalogueApply){const r=(await sql<{request:unknown;binding:unknown}>`SELECT request,binding FROM expected_roster_catalogue_bindings
  WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(this.db)).rows[0];
  if(!r)return null;if(canonicalContextJson(r.request)!==canonicalContextJson(request))throw new RosterCatalogueError('conflict');
  return this.decorate(owner,RosterCatalogueBindingSchema.parse(r.binding));}
 async save(owner:string,request:RosterCatalogueApply,binding:RosterCatalogueBinding,aliases:{providerPlayerId:string;name:string|null}[]=[]){return this.db.transaction().execute(async tx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`catalogue-binding:${owner}:${request.providerTeamId}`},0))`.execute(tx);
  const repo=new RosterCatalogueRepository(tx),replay=await repo.replay(owner,request);if(replay)return replay;
  if(await repo.revision(owner,request.providerTeamId)!==request.expectedRevision)throw new RosterCatalogueError('conflict');
  const value=RosterCatalogueBindingSchema.parse(binding);
  // Check and lock global player links before inserting the team snapshot (legacy projection reads snapshots).
  const links=new PlayerCatalogueRepository(tx);
  for(const p of [...request.players].sort((a,b)=>a.providerPlayerId.localeCompare(b.providerPlayerId)))
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`player-link:${owner}:${p.providerPlayerId}`},0))`.execute(tx);
  await links.checkLinks(owner,request);
  const row=(await sql<{id:string}>`INSERT INTO expected_roster_catalogue_bindings(owner_user_id,request_id,provider_team_id,team_id,revision,request,binding)
   VALUES(${owner}::uuid,${request.requestId}::uuid,${request.providerTeamId},${value.teamId},${value.revision},${JSON.stringify(request)}::jsonb,${JSON.stringify(value)}::jsonb) RETURNING id`.execute(tx)).rows[0]!;
  for(const p of value.players)await sql`INSERT INTO provider_player_links(owner_user_id,provider,external_player_id,player_id,account_id,binding_id)
   VALUES(${owner}::uuid,'pandascore',${p.providerPlayerId},${p.playerId},${p.accountId},${row.id})`.execute(tx);
  const at=new Date().toISOString();for(const p of value.players){const alias=aliases.find(a=>a.providerPlayerId===p.providerPlayerId)?.name?.trim();
   if(alias)await appendAliasEvidence(tx,{playerId:p.playerId,alias:alias.slice(0,120),source:'owner-reviewed-pandascore-player',evidenceRef:`catalogue-binding:${row.id}:pandascore:${p.providerPlayerId}`,eventAt:null,knownAt:at,fetchedAt:at});}
  return repo.decorate(owner,value);
 });}
 private async decorate(owner:string,binding:RosterCatalogueBinding){const ids=binding.players.map(p=>p.playerId),now=new Date().toISOString();
  const counts=(await sql<{player_id:string;n:number}>`SELECT mp.player_id,count(DISTINCT m.id)::int n FROM match_players mp JOIN matches m ON m.id=mp.match_id
   WHERE mp.player_id=ANY(${ids}::bigint[]) AND m.is_pro IS TRUE AND m.ingest_state<>'conflict' AND m.radiant_win IS NOT NULL AND m.duration_seconds>0
   AND m.started_at<${now} AND m.started_at+make_interval(secs=>m.duration_seconds)<=${now} GROUP BY mp.player_id`.execute(this.db)).rows;
  const identities=await new RoleProfileRepository(this.db).identities(ids);
  const links=new PlayerCatalogueRepository(this.db),current=await Promise.all(binding.players.map(async p=>{const link=await links.link(owner,p.providerPlayerId);return link.rows.length===1&&link.rows[0]!.accountId===p.accountId&&link.rows[0]!.playerId===p.playerId;}));
  return RosterCatalogueBindingSchema.parse({...binding,players:binding.players.map(p=>({...p,proMaps:counts.find(c=>c.player_id===p.playerId)?.n??0,
   identityStatus:identities.find(i=>i.playerId===p.playerId)?.identityStatus??'unknown'})),usable:current.every(Boolean)&&identities.every(p=>p.identityStatus==='verified')});
 }
}
