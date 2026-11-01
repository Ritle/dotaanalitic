import {createHash} from 'node:crypto';
import {CatalogIdSchema,SeriesProvisionRequestSchema,SeriesPlanFingerprintSchema,SeriesProvisionResultSchema} from '@dota/contracts';
import {sql,type Db,type Executor} from './index.js';
import {OutcomeVerifier} from './outcome-verifier.js';
import {canonicalContextJson} from './temporal.js';
const POLICY='reviewed-opendota-series-v3';
// Valve GetLeagueData links series_type=3 to ELeagueNodeType.BEST_OF_TWO=4.
// These are different enums; evidence and pinned protobuf are in S1_08_SERIES_PROVISION.md.
// A BO2 can end 1-1. This limit never assigns a series winner or completion status.
// Explicit series_type=0 is BO1, not missing: Valve league 17765 binds five
// series to BEST_OF_ONE=1 nodes. See S3_01_E1_LINKS.md for pinned evidence.
function bestOfForSeriesType(type:string|null|undefined):number|null{
  switch(type){case '0':return 1;case '1':return 3;case '2':return 5;case '3':return 2;default:return null;}
}
const compare=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const unique=(values:string[])=>[...new Set(values)].sort(compare);
const fingerprint=(value:unknown)=>createHash('sha256').update(canonicalContextJson(value)).digest('hex');
type Request=ReturnType<typeof SeriesProvisionRequestSchema.parse>;
interface Receipt {id:string;mapId:string;canonicalMapId:string|null;status:string;fetchedAt:string;sha256:string;
  seriesId:string|null;seriesType:string|null;payloadMapId:string|null;radiant:string|null;dire:string|null;league:string|null}
interface MapRow {id:string;isPro:boolean|null;ingestState:string;dataRevision:string;startedAt:string;seriesId:string|null;
  linkedProvider:string|null;linkedProviderSeriesId:string|null;radiant:string|null;dire:string|null;league:string|null;
  externalRadiant:string|null;externalDire:string|null;externalLeague:string|null}
interface Existing {id:string;providerSeriesId:string;teamAId:string;teamBId:string;leagueId:string|null;bestOf:number}
function normalized(input:unknown){const request=SeriesProvisionRequestSchema.parse(input);
  return {...request,providerSeriesIds:[...request.providerSeriesIds].sort(compare)};}

async function planOn(db:Executor,request:Request){
  if((await sql<{future:boolean}>`SELECT ${request.snapshotAt}::timestamptz>clock_timestamp() AS future`.execute(db)).rows[0]!.future)
    throw new Error('series_snapshot_in_future');
  const ids=request.providerSeriesIds;
  // Include raw received/quarantined observations and every locally known sibling,
  // not just the map that originally motivated this review.
  const targets=(await sql<{id:string}>`SELECT DISTINCT id FROM (
    SELECT provider_match_id AS id FROM provider_ingest_receipts WHERE provider='opendota' AND source_payload->>'series_id'=ANY(${ids}::text[])
    UNION SELECT canonical_match_id::text FROM provider_ingest_receipts WHERE provider='opendota'
      AND source_payload->>'series_id'=ANY(${ids}::text[]) AND canonical_match_id IS NOT NULL
    UNION SELECT m.id::text FROM matches m JOIN series s ON s.id=m.series_id
      WHERE s.provider='opendota' AND s.provider_series_id=ANY(${ids}::text[])) t ORDER BY id LIMIT 501`.execute(db)).rows;
  if(targets.length>500)throw new Error('series_inventory_limit');
  const mapIds=targets.map(r=>CatalogIdSchema.parse(r.id));
  const receipts=(await sql<Receipt>`SELECT id::text,provider_match_id AS "mapId",canonical_match_id::text AS "canonicalMapId",status,
    to_char(fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "fetchedAt",payload_sha256 AS sha256,
    source_payload->>'series_id' AS "seriesId",source_payload->>'series_type' AS "seriesType",source_payload->>'match_id' AS "payloadMapId",
    source_payload->>'radiant_team_id' AS radiant,source_payload->>'dire_team_id' AS dire,source_payload->>'leagueid' AS league
    FROM provider_ingest_receipts WHERE provider='opendota' AND
      (provider_match_id=ANY(${mapIds}::text[]) OR canonical_match_id::text=ANY(${mapIds}::text[])) ORDER BY id LIMIT 5001`.execute(db)).rows;
  if(receipts.length>5000)throw new Error('series_inventory_limit');
  const maps=(await sql<MapRow>`SELECT m.id::text,m.is_pro AS "isPro",m.ingest_state AS "ingestState",m.data_revision::text AS "dataRevision",
    to_char(m.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",m.series_id AS "seriesId",
    s.provider AS "linkedProvider",s.provider_series_id AS "linkedProviderSeriesId",
    m.radiant_team_id::text AS radiant,m.dire_team_id::text AS dire,m.league_id::text AS league,
    a.opendota_team_id::text AS "externalRadiant",b.opendota_team_id::text AS "externalDire",l.opendota_league_id::text AS "externalLeague"
    FROM matches m LEFT JOIN teams a ON a.id=m.radiant_team_id LEFT JOIN teams b ON b.id=m.dire_team_id
      LEFT JOIN leagues l ON l.id=m.league_id LEFT JOIN series s ON s.id=m.series_id
    WHERE m.id::text=ANY(${mapIds}::text[]) ORDER BY m.id`.execute(db)).rows;
  const existing=(await sql<Existing>`SELECT id,provider_series_id AS "providerSeriesId",team_a_id::text AS "teamAId",
    team_b_id::text AS "teamBId",league_id::text AS "leagueId",best_of AS "bestOf" FROM series
    WHERE provider='opendota' AND provider_series_id=ANY(${ids}::text[]) ORDER BY id`.execute(db)).rows;
  const outcomes=new Map<string,Awaited<ReturnType<OutcomeVerifier['verifyProMap']>>>();
  for(const m of maps)outcomes.set(m.id,await new OutcomeVerifier(db).verifyProMap({matchId:m.id,snapshotAt:request.snapshotAt,teamASide:'radiant'}));
  const groups=ids.map(providerSeriesId=>{
    const selectedIds=unique([...receipts.filter(r=>r.seriesId===providerSeriesId).map(r=>r.mapId),
      ...maps.filter(m=>m.linkedProvider==='opendota'&&m.linkedProviderSeriesId===providerSeriesId).map(m=>m.id)]);
    const selected=maps.filter(m=>selectedIds.includes(m.id)),evidence=receipts.filter(r=>selectedIds.includes(r.mapId)||r.canonicalMapId!==null&&selectedIds.includes(r.canonicalMapId));
    const reasons:string[]=[];
    if(!selectedIds.length)reasons.push('SERIES_NOT_OBSERVED');
    if(selected.length!==selectedIds.length)reasons.push('CANONICAL_MAP_MISSING');
    for(const m of selected){
      if(m.isPro!==true||m.ingestState==='conflict'||outcomes.get(m.id)?.status!=='verified')reasons.push('MAP_OUTCOME_UNVERIFIED');
      if(!m.radiant||!m.dire||m.radiant===m.dire||!m.league||!m.externalRadiant||!m.externalDire||!m.externalLeague)reasons.push('CANONICAL_REFERENCES_MISSING');
      if(m.seriesId&&(m.linkedProvider!=='opendota'||m.linkedProviderSeriesId!==providerSeriesId))reasons.push('MAP_ALREADY_LINKED_ELSEWHERE');
    }
    for(const r of evidence){
      const m=selected.find(m=>m.id===r.mapId);
      if(r.seriesId!==providerSeriesId)reasons.push('MAP_SERIES_CONFLICT');
      if(r.payloadMapId!==r.mapId||r.canonicalMapId!==null&&r.canonicalMapId!==r.mapId)reasons.push('RECEIPT_MAP_MISMATCH');
      if(r.status==='conflict'||r.status==='quarantined')reasons.push('RECEIPT_CONFLICT');
      if(r.fetchedAt>request.snapshotAt.slice(0,-1)+'000Z')reasons.push('RECEIPT_AFTER_SNAPSHOT');
      if(!m||r.radiant!==m.externalRadiant||r.dire!==m.externalDire||r.league!==m.externalLeague)reasons.push('RECEIPT_REFERENCES_MISMATCH');
    }
    const types=[...new Set(evidence.map(r=>r.seriesType))];
    if(types.some(t=>bestOfForSeriesType(t)===null)||!types.length)reasons.push('SERIES_TYPE_UNSUPPORTED');
    if(types.length>1)reasons.push('SERIES_TYPE_CONFLICT');
    const bestOf=types.length===1?bestOfForSeriesType(types[0]):null;
    const pairs=[...new Set(selected.map(m=>m.radiant&&m.dire?unique([m.radiant,m.dire]).join(':'):'unknown'))];
    const leagues=[...new Set(selected.map(m=>m.league))];
    if(pairs.length>1)reasons.push('SERIES_PARTICIPANTS_CONFLICT');
    if(leagues.length>1)reasons.push('SERIES_LEAGUE_CONFLICT');
    if(bestOf!==null&&selectedIds.length>bestOf)reasons.push('SERIES_MAP_COUNT_EXCEEDED');
    const pair=pairs.length===1&&pairs[0]!=='unknown'?pairs[0]!.split(':'):[];
    const teamAId=pair[0]??null,teamBId=pair[1]??null,leagueId=leagues.length===1?leagues[0]??null:null;
    const registered=existing.filter(s=>s.providerSeriesId===providerSeriesId);
    if(registered.length>1)reasons.push('CANONICAL_SERIES_AMBIGUOUS');
    if(registered.some(s=>unique([s.teamAId,s.teamBId]).join(':')!==pair.join(':')||s.leagueId!==leagueId||s.bestOf!==bestOf))
      reasons.push('CANONICAL_SERIES_CONFLICT');
    return {providerSeriesId,teamAId,teamBId,leagueId,bestOf,mapIds:selectedIds,existingSeriesId:registered.length===1?registered[0]!.id:null,
      reasons:[...new Set(reasons)].sort(),maps:selected.map(m=>({...m,outcome:outcomes.get(m.id)})),receipts:evidence};
  });
  const body={policyVersion:POLICY,request,status:groups.some(g=>g.reasons.length)?'blocked' as const:'ready' as const,groups,
    remoteMembershipCompleteness:'unknown',historicalAvailability:'not_assessed',trainingReady:false,deployable:false};
  return {...body,fingerprint:fingerprint(body)};
}

export class SeriesProvisionRepository {
  constructor(private readonly db:Db){}
  async preview(input:unknown){const request=normalized(input);
    // OutcomeVerifier takes SHARE row locks; this path executes no mutations.
    return this.db.transaction().setIsolationLevel('repeatable read').execute(tx=>planOn(tx,request));}
  async apply(input:unknown,expected:string){
    const request=normalized(input),digest=SeriesPlanFingerprintSchema.parse(expected);
    return this.db.transaction().execute(async tx=>{
      await sql`SET LOCAL lock_timeout='5s'`.execute(tx);
      // A short local maintenance transaction. Prevent a new receipt, mapping or
      // series from appearing between review revalidation and registration.
      await sql`LOCK TABLE matches,teams,leagues,provider_ingest_receipts,series IN SHARE ROW EXCLUSIVE MODE`.execute(tx);
      const old=(await sql<{request:unknown;result:unknown}>`SELECT plan->'request' AS request,result FROM series_provision_batches WHERE plan_sha256=${digest}`.execute(tx)).rows[0];
      if(old){if(canonicalContextJson(old.request)!==canonicalContextJson(request))throw new Error('series_request_mismatch');
        return {status:'already_applied' as const,fingerprint:digest,...SeriesProvisionResultSchema.parse(old.result)};}
      const plan=await planOn(tx,request);
      if(plan.fingerprint!==digest)throw new Error('series_plan_changed');
      if(plan.status!=='ready')throw new Error('series_plan_not_ready');
      const mappings=[];
      for(const g of plan.groups){
        let id=g.existingSeriesId;
        if(id===null)id=(await sql<{id:string}>`INSERT INTO series(team_a_id,team_b_id,league_id,best_of,status,provider,provider_series_id,notes)
          VALUES (${g.teamAId},${g.teamBId},${g.leagueId},${g.bestOf},NULL,'opendota',${g.providerSeriesId},${POLICY+':'+digest}) RETURNING id`.execute(tx)).rows[0]!.id;
        mappings.push({providerSeriesId:g.providerSeriesId,seriesId:id,mapIds:g.mapIds,created:g.existingSeriesId===null});
      }
      const result=SeriesProvisionResultSchema.parse({created:mappings.filter(m=>m.created).length,mappings,mapWrites:0,
        historicalAvailability:'not_assessed',trainingReady:false,deployable:false});
      await sql`INSERT INTO series_provision_batches(plan_sha256,policy_version,plan,result)
        VALUES (${digest},${POLICY},${JSON.stringify(plan)}::jsonb,${JSON.stringify(result)}::jsonb)`.execute(tx);
      return {status:'applied' as const,fingerprint:digest,...result};
    });
  }
}
