import {sql,RoleProfileRepository,readAccountEvidence,resolveIdentity,type Db} from '@dota/db';

/** Read model for current UI context only; never writes players, teams or historical facts. */
export class RosterContextRepository{
 constructor(private readonly db:Db){}
 async expireRegistry(observation:unknown){
  // Compare-and-set: a concurrent valid refresh must not be expired by an older reader.
  await sql`UPDATE roster_catalogue_cache SET expires_at=clock_timestamp()-interval '1 second'
   WHERE source_key='registry' AND observation=${JSON.stringify(observation)}::jsonb`.execute(this.db);
 }
 async entity(kind:'teams'|'players',id:string){
  return kind==='teams'?(await sql<{id:string;name:string;providerId:string|null}>`SELECT id::text,name,opendota_team_id::text AS "providerId" FROM teams WHERE id=${id}`.execute(this.db)).rows[0]??null:
   (await sql<{id:string;name:string;providerId:null}>`SELECT id::text,nickname AS name,NULL::text AS "providerId" FROM players WHERE id=${id}`.execute(this.db)).rows[0]??null;
 }
 async teams(providerIds:string[]){
  return (await sql<{id:string;name:string;providerId:string}>`SELECT id::text,name,opendota_team_id::text AS "providerId" FROM teams WHERE opendota_team_id=ANY(${providerIds}::bigint[])`.execute(this.db)).rows;
 }
 async playerIdentity(id:string){return (await new RoleProfileRepository(this.db).identities([id]))[0]!;}
 async members(accounts:string[],now:string){
  const evidence=(await readAccountEvidence(this.db,accounts)).filter(e=>e.fetchedAt<=now&&(e.knownAt===null||e.knownAt<=now)&&(e.eventAt===null||e.eventAt<=now));
  const resolutions=accounts.map(accountId=>({accountId,...resolveIdentity(evidence,accountId,null)}));
  const ids=[...new Set(resolutions.flatMap(r=>r.playerId?[r.playerId]:[]))];
  const identities=await new RoleProfileRepository(this.db).identities(ids);
  const names=(await sql<{id:string;name:string}>`SELECT id::text,nickname AS name FROM players WHERE id=ANY(${ids}::bigint[])`.execute(this.db)).rows;
  return resolutions.map(r=>{const identity=identities.find(i=>i.playerId===r.playerId);
   const verified=r.status==='verified'&&identity?.identityStatus==='verified'&&identity.accountIds[0]===r.accountId;
   return {accountId:r.accountId,playerId:verified?r.playerId:null,localName:verified?names.find(n=>n.id===r.playerId)?.name??null:null,
    identityStatus:verified?'verified' as const:r.status==='conflict'||identity?.identityStatus==='conflict'?'conflict' as const:'unknown' as const};});
 }
}
