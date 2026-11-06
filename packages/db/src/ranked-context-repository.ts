import {randomUUID,createHash} from 'node:crypto';
import {CatalogIdSchema,RankedContextReceiptSchema,RankedPracticeObservationSchema,RANKED_CONTEXT_POLICY,RANKED_PRACTICE_ADAPTER_VERSION,type RankedContextReceipt,type RankedContextSourceEntry,type RankedPracticeMap,type RankedContextReportMap} from '@dota/contracts';
import {selectRankedContextMaps,rankedContextConflict} from '@dota/analytics';
import {sql,type Db} from './index.js';
import {RoleProfileRepository} from './role-profile-repository.js';
export type CachedRankedContext={id:string;parentId:string;receipt:RankedContextReceipt;entry:RankedContextSourceEntry;fresh:boolean};
export class RankedContextRepository{
 constructor(private readonly db:Db){}
 selectMaps(maps:readonly RankedPracticeMap[]){return selectRankedContextMaps(maps);}
 describe(maps:readonly RankedPracticeMap[],cached:ReadonlyMap<string,CachedRankedContext>):RankedContextReportMap[]{
  return this.selectMaps(maps).map(m=>{
   const base={matchId:m.matchId,heroId:m.heroId,startedAt:m.startedAt,position:null,roleBasis:'unknown' as const,gameVersionCode:null,averageRank:null},c=cached.get(m.matchId);
   if(!c)return {...base,status:'not_loaded',reason:'not_loaded',sourceReceiptId:null,sourceParentObservationId:null,sourceFetchedAt:null,sourceSha256:null,stale:false};
   const source={sourceReceiptId:c.id,sourceParentObservationId:c.parentId,sourceFetchedAt:c.receipt.fetchedAt,sourceSha256:c.receipt.payloadSha256,stale:!c.fresh},e=c.entry;
   if(e.status==='found'&&e.map){const reason=rankedContextConflict(m,e.map);return reason?{...base,...source,status:'conflict',reason}:{...base,...source,status:'matched',reason:null,position:e.map.position,roleBasis:e.map.roleBasis,gameVersionCode:e.map.patchCode,averageRank:e.map.averageRank};}
   return {...base,...source,status:e.status==='invalid'&&e.reason!=='invalid_row'?'conflict':'unavailable',reason:e.reason};
  });
 }
 private account(id:string){CatalogIdSchema.parse(id);if(BigInt(id)>4294967295n)throw Error('invalid_ranked_account');return id;}
 async cached(accountId:string,matchIds:readonly string[]):Promise<Map<string,CachedRankedContext>>{
  this.account(accountId);matchIds.forEach(id=>CatalogIdSchema.parse(id));if(!matchIds.length)return new Map();
  const rows=(await sql<{match_id:string;id:string;parent_id:string;payload:unknown;fresh:boolean}>`SELECT c.match_id::text,r.id::text,r.parent_observation_id::text parent_id,r.payload,(c.expires_at>clock_timestamp()) IS TRUE fresh
   FROM ranked_context_map_cache c JOIN ranked_context_receipts r ON r.id=c.receipt_id
   WHERE c.account_id=${accountId}::bigint AND c.match_id=ANY(${[...matchIds]}::bigint[]) AND c.policy_version=${RANKED_CONTEXT_POLICY}`.execute(this.db)).rows;
  const result=new Map<string,CachedRankedContext>(),now=new Date().toISOString();
  for(const row of rows){const parsed=RankedContextReceiptSchema.safeParse(row.payload);if(!parsed.success||parsed.data.accountId!==accountId||parsed.data.fetchedAt>now)continue;
   const entry=parsed.data.entries.find(e=>e.matchId===row.match_id);if(entry)result.set(row.match_id,{id:row.id,parentId:row.parent_id,receipt:parsed.data,entry,fresh:row.fresh});}
  return result;
 }
 async state(accountId:string){
  this.account(accountId);const row=(await sql<{busy:boolean;retry_at:Date|null;failure_code:string|null}>`SELECT lease_until>clock_timestamp() busy,CASE WHEN retry_at>clock_timestamp() THEN retry_at ELSE NULL END retry_at,failure_code FROM ranked_context_leases WHERE account_id=${accountId}::bigint`.execute(this.db)).rows[0];
  return {reason:row?.busy?'refresh_in_progress':row?.retry_at?row.failure_code??'cooldown':null,retryAt:row?.retry_at?.toISOString()??null};
 }
 async claim(accountId:string){
  this.account(accountId);const token=randomUUID();return this.db.transaction().execute(async tx=>{
   await sql`INSERT INTO ranked_context_leases(account_id) VALUES(${accountId}::bigint) ON CONFLICT DO NOTHING`.execute(tx);
   const r=await sql`UPDATE ranked_context_leases SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '120 seconds'
    WHERE account_id=${accountId}::bigint AND lease_until<=clock_timestamp() AND retry_at<=clock_timestamp() RETURNING account_id`.execute(tx);return r.rows.length?token:null;
  });
 }
 async finish(accountId:string,token:string){
  this.account(accountId);await sql`UPDATE ranked_context_leases SET lease_token=NULL,lease_until='-infinity',retry_at='-infinity',failure_code=NULL WHERE account_id=${accountId}::bigint AND lease_token=${token}::uuid`.execute(this.db);
 }
 async fail(accountId:string,token:string,code:string,retryMs=60000){
  this.account(accountId);if(!/^[a-z_]{1,60}$/.test(code))throw Error('invalid_context_failure');const wait=Math.max(1000,Math.min(900000,retryMs));
  await sql`UPDATE ranked_context_leases SET lease_token=NULL,lease_until='-infinity',failure_code=${code},retry_at=clock_timestamp()+(${wait}::int*interval '1 millisecond') WHERE account_id=${accountId}::bigint AND lease_token=${token}::uuid`.execute(this.db);
 }
 async publish(playerId:string,parentId:string,accountId:string,token:string,input:unknown,rawBody:string){
  CatalogIdSchema.parse(playerId);this.account(accountId);const receipt=RankedContextReceiptSchema.parse(input);
  if(receipt.accountId!==accountId||receipt.payloadSha256!==createHash('sha256').update(rawBody).digest('hex')||receipt.fetchedAt>new Date().toISOString())throw Error('invalid_context_receipt');
  return this.db.transaction().execute(async tx=>{
   const revision=(await sql<{revision:string}>`SELECT revision::text FROM identity_registry_state WHERE singleton FOR SHARE`.execute(tx)).rows[0]!.revision,
    identity=(await new RoleProfileRepository(tx).identities([playerId]))[0]!;
   if(identity.identityStatus!=='verified'||identity.accountIds[0]!==accountId)throw Error('ranked_context_identity_changed');
   const row=(await sql<{payload:unknown;player_id:string}>`SELECT o.payload,o.player_id::text FROM ranked_practice_cache c JOIN ranked_practice_observations o ON o.id=c.observation_id
    WHERE c.source_key=${'opendota:'+accountId} AND o.id=${parentId}::uuid FOR SHARE OF c`.execute(tx)).rows[0];
   const parent=RankedPracticeObservationSchema.safeParse(row?.payload);
   if(!parent.success||row?.player_id!==playerId||parent.data.provider!=='opendota'||parent.data.accountId!==accountId||parent.data.adapterVersion!==RANKED_PRACTICE_ADAPTER_VERSION||parent.data.coverage.conflicts)throw Error('ranked_context_parent_changed');
   const selected=selectRankedContextMaps(parent.data.maps),allowed=new Set(selected.map(m=>m.matchId));if(receipt.entries.some(e=>!allowed.has(e.matchId)))throw Error('ranked_context_membership_invalid');
   const lease=await sql`SELECT account_id FROM ranked_context_leases WHERE account_id=${accountId}::bigint AND lease_token=${token}::uuid AND lease_until>clock_timestamp() FOR UPDATE`.execute(tx);
   if(!lease.rows.length)return false;
   const id=randomUUID();await sql`INSERT INTO ranked_context_receipts(id,parent_observation_id,player_id,account_id,identity_revision,policy_version,fetched_at,payload,raw_body)
    VALUES(${id}::uuid,${parentId}::uuid,${playerId}::bigint,${accountId}::bigint,${revision}::bigint,${RANKED_CONTEXT_POLICY},${receipt.fetchedAt}::timestamptz,${JSON.stringify(receipt)}::jsonb,${rawBody})`.execute(tx);
   for(const e of receipt.entries)await sql`INSERT INTO ranked_context_map_cache(account_id,match_id,policy_version,receipt_id,expires_at)
    VALUES(${accountId}::bigint,${e.matchId}::bigint,${RANKED_CONTEXT_POLICY},${id}::uuid,clock_timestamp()+${e.status==='found'&&e.map&&rankedContextConflict(selected.find(m=>m.matchId===e.matchId)!,e.map)===null?'24 hours':'1 hour'}::interval)
    ON CONFLICT(account_id,match_id,policy_version) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,expires_at=EXCLUDED.expires_at`.execute(tx);
   return true;
  });
 }
}
