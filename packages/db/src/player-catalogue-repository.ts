import {createHash} from 'node:crypto';
import {sql,type Db} from './index.js';
import type {RosterCatalogueApply,RosterCatalogueCandidate} from '@dota/contracts';
import {RoleProfileRepository} from './role-profile-repository.js';
import {RosterCatalogueError} from './roster-catalogue-repository.js';
type Link={playerId:string;accountId:string;decisionId:string};
export class PlayerCatalogueRepository{
 constructor(private readonly db:Db){}
 async link(owner:string,providerPlayerId:string){
  let rows=(await sql<Link>`SELECT player_id AS "playerId",account_id AS "accountId",'global:'||id AS "decisionId" FROM provider_player_links
   WHERE owner_user_id=${owner}::uuid AND external_player_id=${providerPlayerId} ORDER BY id DESC LIMIT 1`.execute(this.db)).rows;
  // Conservative compatibility: latest five per team, no arbitrary winner between conflicting teams.
  if(!rows.length)rows=(await sql<Link>`WITH current AS (SELECT DISTINCT ON(provider_team_id) id,binding FROM expected_roster_catalogue_bindings
    WHERE owner_user_id=${owner}::uuid ORDER BY provider_team_id,revision DESC)
   SELECT DISTINCT p->>'playerId' AS "playerId",p->>'accountId' AS "accountId",'legacy:'||c.id AS "decisionId"
   FROM current c CROSS JOIN LATERAL jsonb_array_elements(c.binding->'players') p WHERE p->>'providerPlayerId'=${providerPlayerId}
   ORDER BY "decisionId"`.execute(this.db)).rows;
  const token=createHash('sha256').update(JSON.stringify({owner,providerPlayerId,rows})).digest('hex');
  const unique=[...new Map(rows.map(r=>[r.accountId+':'+r.playerId,r])).values()];return {token,rows:unique};
 }
 async checkLinks(owner:string,request:RosterCatalogueApply){
  for(const p of request.players){const link=await this.link(owner,p.providerPlayerId);
   if(p.linkToken&&p.linkToken!==link.token)throw new RosterCatalogueError('conflict');
   if(!p.linkToken&&link.rows.some(r=>r.accountId!==p.accountId)){
    // Legacy clients already send an optimistic team revision. It authorizes only that team's current decision.
    const compatible=link.rows.length===1&&(await sql`SELECT 1 FROM provider_player_links l JOIN expected_roster_catalogue_bindings b ON b.id=l.binding_id
     WHERE 'global:'||l.id=${link.rows[0]!.decisionId} AND b.owner_user_id=${owner}::uuid AND b.provider_team_id=${request.providerTeamId}
     AND b.revision=${request.expectedRevision}`.execute(this.db)).rows.length===1;
    if(!compatible)throw new RosterCatalogueError('conflict');
   }
  }
 }
 async cards(ids:readonly string[]):Promise<RosterCatalogueCandidate[]>{
  if(!ids.length)return [];
  const now=new Date().toISOString(),identities=await new RoleProfileRepository(this.db).identities(ids);
  const rows=(await sql<{id:string;nickname:string;aliases:string[];observed:Date|null;n:number}>`SELECT p.id,p.nickname,
   ARRAY(SELECT DISTINCT a.alias FROM player_alias_history a WHERE a.player_id=p.id AND a.observed_at<=${now}
    AND (a.known_at IS NULL OR a.known_at<=${now}) ORDER BY a.alias LIMIT 30) aliases,
   (SELECT max(fetched_at) FROM player_account_evidence e WHERE e.player_id=p.id AND e.fetched_at<=${now}) observed,
   (SELECT count(DISTINCT m.id)::int FROM match_players mp JOIN matches m ON m.id=mp.match_id WHERE mp.player_id=p.id
    AND m.is_pro IS TRUE AND m.ingest_state<>'conflict' AND m.radiant_win IS NOT NULL AND m.duration_seconds>0
    AND m.started_at<${now} AND m.started_at+make_interval(secs=>m.duration_seconds)<=${now}) n
   FROM players p WHERE p.id=ANY(${ids}::bigint[]) ORDER BY p.id`.execute(this.db)).rows;
  return rows.flatMap(p=>{const identity=identities.find(i=>i.playerId===p.id);if(identity?.identityStatus!=='verified')return [];
   return [{id:identity.accountIds[0]!,name:p.nickname,localPlayerId:p.id,teamId:null,teamName:null,aliases:p.aliases,proMaps:p.n,
    ...(p.observed?{observedAt:p.observed.toISOString()}:{}),reason:'Подтверждённый локальный аккаунт; совпадение ника не подтверждает участие'}];});
 }
 async search(query:string){
  const q=query.trim().toLowerCase();if(!q)return [];
  const ids=(await sql<{id:string}>`SELECT p.id FROM players p WHERE p.opendota_account_id::text=${q}
   OR EXISTS(SELECT 1 FROM player_account_evidence e WHERE e.player_id=p.id AND e.external_account_id=${q})
   OR EXISTS(SELECT 1 FROM player_external_accounts e WHERE e.player_id=p.id AND e.external_account_id=${q})
   OR position(${q} in lower(p.nickname COLLATE "und-x-icu"))>0 OR EXISTS(SELECT 1 FROM player_alias_history a WHERE a.player_id=p.id
    AND a.observed_at<=clock_timestamp() AND (a.known_at IS NULL OR a.known_at<=clock_timestamp()) AND position(${q} in lower(a.alias COLLATE "und-x-icu"))>0)
   ORDER BY p.id LIMIT 25`.execute(this.db)).rows.map(p=>p.id);
  return this.cards(ids);
 }
}
