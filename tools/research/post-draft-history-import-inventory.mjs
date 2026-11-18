import {sql,readAccountEvidence} from '../../packages/db/dist/index.js';
const unique=v=>[...new Set(v)].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);

// Same projection as the immutable planning capture; keep its original metadata.
export async function readImportInventory(db,baseline){
 const accounts=baseline.accounts;
 return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
  await sql`SET TRANSACTION READ ONLY`.execute(tx);
  const claims=await readAccountEvidence(tx,accounts),playerIds=unique(claims.map(c=>c.playerId));
  const linked=(await sql`SELECT external_account_id FROM player_account_evidence WHERE player_id=ANY(${playerIds}::bigint[])
   UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=ANY(${playerIds}::bigint[]) AND provider IN ('opendota','stratz')`.execute(tx)).rows;
  const identities=await readAccountEvidence(tx,unique([...accounts,...linked.map(r=>r.external_account_id)]));
  const players=(await sql`SELECT id::text,opendota_account_id::text,steam64_id,nickname FROM players
   WHERE opendota_account_id=ANY(${accounts}::bigint[]) OR id=ANY(${playerIds}::bigint[]) ORDER BY id`.execute(tx)).rows;
  const teams=(await sql`SELECT id::text,opendota_team_id::text,name FROM teams ORDER BY id`.execute(tx)).rows;
  const leagues=(await sql`SELECT id::text,opendota_league_id::text,name,tier FROM leagues ORDER BY id`.execute(tx)).rows;
  const series=(await sql`SELECT s.id::text,s.provider,s.provider_series_id,s.best_of,s.status,
   a.opendota_team_id::text AS radiant,b.opendota_team_id::text AS dire,l.opendota_league_id::text AS league
   FROM series s JOIN teams a ON a.id=s.team_a_id JOIN teams b ON b.id=s.team_b_id LEFT JOIN leagues l ON l.id=s.league_id ORDER BY s.id`.execute(tx)).rows;
  const maps=(await sql`SELECT m.id::text,m.series_id::text,m.is_pro,m.ingest_state,m.data_revision::text,m.started_at,m.duration_seconds,m.radiant_win,
   s.provider,s.provider_series_id,a.opendota_team_id::text AS radiant,b.opendota_team_id::text AS dire,l.opendota_league_id::text AS league
   FROM matches m LEFT JOIN teams a ON a.id=m.radiant_team_id LEFT JOIN teams b ON b.id=m.dire_team_id
   LEFT JOIN leagues l ON l.id=m.league_id LEFT JOIN series s ON s.id=m.series_id ORDER BY m.id LIMIT 10001`.execute(tx)).rows;
  const receipts=(await sql`SELECT id::text,provider_match_id AS map_id,canonical_match_id::text,status,payload_sha256,fetched_at,
   source_payload->>'match_id' AS payload_map_id,source_payload->>'series_id' AS series_id,source_payload->>'series_type' AS series_type,
   source_payload->>'radiant_team_id' AS radiant,source_payload->>'dire_team_id' AS dire,source_payload->>'leagueid' AS league,
   source_payload->>'start_time' AS start_time,source_payload->>'duration' AS duration,source_payload->>'radiant_win' AS radiant_win
   FROM provider_ingest_receipts WHERE provider='opendota' ORDER BY id LIMIT 20001`.execute(tx)).rows;
  if(maps.length>10000||receipts.length>20000)throw Error('inventory_overflow');
  const references=(await sql`SELECT DISTINCT ON(endpoint) id::text,endpoint,adapter_version,payload_sha256,fetched_at,source_payload FROM provider_reference_snapshots
   WHERE provider='opendota' AND endpoint IN ('/leagues','/heroes') ORDER BY endpoint,fetched_at DESC,id DESC`.execute(tx)).rows;
  const heroes=(await sql`SELECT id,internal_name,localized_name FROM heroes ORDER BY id`.execute(tx)).rows;
  return JSON.parse(JSON.stringify({...baseline,identities,players,teams,leagues,series,maps,receipts,references,heroes}));
 });
}
