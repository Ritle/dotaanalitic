import {randomUUID,createHash} from 'node:crypto';
import {sql,type Db} from './index.js';
import {RankedPracticeObservationSchema,RANKED_PRACTICE_ADAPTER_VERSION,type RankedProvider} from '@dota/contracts';
import {RoleProfileRepository} from './role-profile-repository.js';
import {describeRankedPracticeHeroes} from './ranked-practice-summary.js';
export class RankedPracticeRepository{
 constructor(private readonly db:Db){}
 async heroSummary(observationId:string,observation:import('@dota/contracts').RankedPracticeObservation){return describeRankedPracticeHeroes(this.db,observationId,observation);}
 key(provider:RankedProvider,accountId:string){if(!/^[1-9]\d{0,9}$/.test(accountId)||BigInt(accountId)>4294967295n)throw Error('invalid_ranked_account');return `${provider}:${accountId}`;}
 async read(provider:RankedProvider,accountId:string){
  const row=(await sql<{id:string|null;player_id:string|null;identity_revision:string|null;payload:unknown;fresh:boolean;reason:string|null;retry_at:Date|null}>`
   SELECT o.id,o.player_id,o.identity_revision::text,o.payload,(c.expires_at>clock_timestamp()) IS TRUE fresh,
   CASE WHEN c.lease_until>clock_timestamp() THEN 'refresh_in_progress' WHEN c.retry_at>clock_timestamp() THEN 'cooldown' ELSE c.failure_code END reason,
   CASE WHEN c.retry_at>clock_timestamp() THEN c.retry_at ELSE NULL END retry_at
   FROM ranked_practice_cache c LEFT JOIN ranked_practice_observations o ON o.id=c.observation_id
   WHERE c.source_key=${this.key(provider,accountId)}`.execute(this.db)).rows[0];
  const parsed=RankedPracticeObservationSchema.safeParse(row?.payload);
  const valid=parsed.success&&parsed.data.provider===provider&&parsed.data.accountId===accountId&&parsed.data.fetchedAt<=new Date().toISOString();
  return {observation:valid&&parsed.success?parsed.data:null,id:valid?row?.id??null:null,playerId:valid?row?.player_id??null:null,
   identityRevision:valid?row?.identity_revision??null:null,fresh:valid&&row?.fresh===true&&parsed.success&&parsed.data.adapterVersion===RANKED_PRACTICE_ADAPTER_VERSION,reason:row?.reason??(valid?null:'not_loaded'),retryAt:row?.retry_at?.toISOString()??null};
 }
 async claim(provider:RankedProvider,accountId:string){
  const key=this.key(provider,accountId),token=randomUUID();
  return this.db.transaction().execute(async tx=>{
   await sql`INSERT INTO ranked_practice_cache(source_key) VALUES(${key}) ON CONFLICT DO NOTHING`.execute(tx);
   const result=await sql`UPDATE ranked_practice_cache SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '50 seconds'
    WHERE source_key=${key} AND (expires_at IS NULL OR expires_at<=clock_timestamp() OR EXISTS(
     SELECT 1 FROM ranked_practice_observations o WHERE o.id=ranked_practice_cache.observation_id AND coalesce(o.payload->>'adapterVersion','')<>${RANKED_PRACTICE_ADAPTER_VERSION}))
    AND lease_until<=clock_timestamp() AND retry_at<=clock_timestamp() RETURNING source_key`.execute(tx);
   return result.rows.length?token:null;
  });
 }
 async publish(playerId:string,provider:RankedProvider,accountId:string,token:string,input:unknown,rawBodies:readonly string[]){
  const observation=RankedPracticeObservationSchema.parse(input),key=this.key(provider,accountId);
  if(observation.adapterVersion!==RANKED_PRACTICE_ADAPTER_VERSION||observation.provider!==provider||observation.accountId!==accountId||rawBodies.length!==observation.receipts.length||rawBodies.some((b,i)=>createHash('sha256').update(b).digest('hex')!==observation.receipts[i]!.payloadSha256))throw Error('invalid_ranked_observation');
  return this.db.transaction().execute(async tx=>{
   const revision=(await sql<{revision:string}>`SELECT revision::text FROM identity_registry_state WHERE singleton FOR SHARE`.execute(tx)).rows[0]!.revision;
   const identity=(await new RoleProfileRepository(tx).identities([playerId]))[0]!;
   if(identity.identityStatus!=='verified'||identity.accountIds[0]!==accountId)throw Error('ranked_identity_changed');
   const lease=await sql`SELECT source_key FROM ranked_practice_cache WHERE source_key=${key} AND lease_token=${token}::uuid AND lease_until>clock_timestamp() FOR UPDATE`.execute(tx);
   if(!lease.rows.length)return false;
   const id=randomUUID();await sql`INSERT INTO ranked_practice_observations(id,player_id,account_id,provider,identity_revision,fetched_at,payload,raw_bodies)
    VALUES(${id}::uuid,${playerId}::bigint,${accountId}::bigint,${provider},${revision}::bigint,${observation.fetchedAt}::timestamptz,${JSON.stringify(observation)}::jsonb,${JSON.stringify(rawBodies)}::jsonb)`.execute(tx);
   const partial=observation.coverage.pagination!=='exhausted'||Object.keys(observation.coverage.excluded).length>0;
   const ttl=partial||!observation.maps.length?900:3600;
   await sql`UPDATE ranked_practice_cache SET observation_id=${id}::uuid,expires_at=clock_timestamp()+${ttl}*interval '1 second',
    lease_token=NULL,lease_until='-infinity',retry_at='-infinity',failure_code=NULL WHERE source_key=${key}`.execute(tx);return true;
  });
 }
 async fail(provider:RankedProvider,accountId:string,token:string,code:string,retryMs=60000){
  if(!/^[a-z_]{1,60}$/.test(code))code='source_unavailable';
  await sql`UPDATE ranked_practice_cache SET lease_token=NULL,lease_until='-infinity',failure_code=${code},
   retry_at=clock_timestamp()+${Math.min(86400000,Math.max(60000,retryMs))}*interval '1 millisecond'
   WHERE source_key=${this.key(provider,accountId)} AND lease_token=${token}::uuid`.execute(this.db);
 }
}
