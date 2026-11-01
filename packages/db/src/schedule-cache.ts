import {createHash,randomUUID} from 'node:crypto';
import {sql,type Db} from './index.js';
import {ScheduleCacheDataSchema,RostersCacheDataSchema} from '@dota/contracts';
export interface ScheduleCacheRow{payload:unknown;expires_at:Date|null;retry_at:Date|null;lease_until:Date|null;failure_code:'source_unavailable'|null;now:Date}
const keyCheck=(key:string)=>{if(!/^(?:schedule|tournament:[1-9]\d{0,18})$/.test(key))throw new Error('invalid_schedule_cache_key');};
export class ScheduleCacheRepository{
  constructor(private readonly db:Db){}
  async read(key:string):Promise<ScheduleCacheRow>{
    keyCheck(key);
    const r=await sql<ScheduleCacheRow>`SELECT c.payload,c.expires_at,CASE WHEN c.retry_at>clock_timestamp() THEN c.retry_at END retry_at,
      CASE WHEN c.lease_until>clock_timestamp() THEN c.lease_until END lease_until,c.failure_code,clock_timestamp() AS now
      FROM (SELECT 1) d LEFT JOIN upcoming_source_cache c ON c.cache_key=${key}`.execute(this.db);
    return r.rows[0]!;
  }
  async claim(key:string):Promise<string|null>{
    keyCheck(key);const token=randomUUID();
    return this.db.transaction().execute(async tx=>{
      await sql`INSERT INTO upcoming_source_cache(cache_key) VALUES (${key}) ON CONFLICT DO NOTHING`.execute(tx);
      await sql`SELECT cache_key FROM upcoming_source_cache WHERE cache_key=${key} FOR UPDATE`.execute(tx);
      const r=await sql`UPDATE upcoming_source_cache SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '90 seconds'
        WHERE cache_key=${key} AND (expires_at IS NULL OR expires_at<=clock_timestamp())
          AND retry_at<=clock_timestamp() AND lease_until<=clock_timestamp() RETURNING cache_key`.execute(tx);
      return r.rows.length?token:null;
    });
  }
  async publish(key:string,token:string,payload:unknown,recordObservation=false){
    keyCheck(key);
    const snapshot=recordObservation?(key==='schedule'?ScheduleCacheDataSchema:RostersCacheDataSchema).parse(payload):null;
    const endpoint=key==='schedule'?'/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20':
      `/tournaments/${key.slice('tournament:'.length)}/rosters`;
    if(snapshot&&snapshot.source.endpoint!==endpoint)throw new Error('source_endpoint_mismatch');
    const snapshotText=snapshot?JSON.stringify(snapshot):null;
    await this.db.transaction().execute(async tx=>{
      const updated=await sql`UPDATE upcoming_source_cache SET payload=${JSON.stringify(payload)}::jsonb,expires_at=clock_timestamp()+interval '5 minutes',
        lease_token=NULL,lease_until='-infinity',retry_at='-infinity',failure_code=NULL
        WHERE cache_key=${key} AND lease_token=${token}::uuid AND lease_until>clock_timestamp() RETURNING cache_key`.execute(tx);
      if(snapshot&&updated.rows.length){
        const digest=createHash('sha256').update(snapshotText!).digest('hex');
        await sql`INSERT INTO upcoming_source_observations(cache_key,provider,source_endpoint,source_payload_sha256,
          source_fetched_at,snapshot_sha256,snapshot_text)
          VALUES (${key},${snapshot.source.provider},${snapshot.source.endpoint},${snapshot.source.payloadSha256},
            ${snapshot.source.fetchedAt},${digest},${snapshotText})`.execute(tx);
      }
    });
  }
  async fail(key:string,token:string,retryAfterMs=60000){
    keyCheck(key);const delay=Number.isFinite(retryAfterMs)?Math.max(60000,Math.ceil(retryAfterMs)):60000;
    await sql`UPDATE upcoming_source_cache SET lease_token=NULL,lease_until='-infinity',failure_code='source_unavailable',
      retry_at=clock_timestamp()+${delay}*interval '1 millisecond'
      WHERE cache_key=${key} AND lease_token=${token}::uuid`.execute(this.db);
  }
}
/** Atomic across API processes and restarts; leaves room below the documented 1000/hour starter limit. */
export class PandaScoreQuotaRepository{
  constructor(private readonly db:Db){}
  async claim(){
    return this.db.transaction().execute(async tx=>{
      await sql`INSERT INTO pandascore_request_quota(singleton) VALUES (true) ON CONFLICT DO NOTHING`.execute(tx);
      await sql`SELECT singleton FROM pandascore_request_quota WHERE singleton FOR UPDATE`.execute(tx);
      await sql`UPDATE pandascore_request_quota SET requests_used=CASE WHEN hour_start<date_trunc('hour',clock_timestamp(),'UTC') THEN 0 ELSE requests_used END,
        hour_start=date_trunc('hour',clock_timestamp(),'UTC') WHERE singleton`.execute(tx);
      const r=await sql<{wait_ms:string}>`SELECT greatest(0,ceil(extract(epoch FROM greatest(next_request_at,blocked_until,
        CASE WHEN requests_used>=900 THEN hour_start+interval '1 hour' ELSE clock_timestamp() END)-clock_timestamp())*1000))::bigint wait_ms
        FROM pandascore_request_quota WHERE singleton`.execute(tx);
      const wait=Number(r.rows[0]!.wait_ms);if(wait>0)return {allowed:false,retryAfterMs:wait};
      await sql`UPDATE pandascore_request_quota SET requests_used=requests_used+1,next_request_at=clock_timestamp()+interval '4 seconds' WHERE singleton`.execute(tx);
      return {allowed:true,retryAfterMs:0};
    });
  }
  async observe(status:number,retryAfterMs:number|null,remaining:number|null){
    const delay=Number.isFinite(retryAfterMs)?Math.max(0,Math.ceil(retryAfterMs!)):0;
    await sql`UPDATE pandascore_request_quota SET blocked_until=greatest(blocked_until,
      CASE WHEN ${status}=429 THEN clock_timestamp()+${Math.max(60000,delay)}*interval '1 millisecond'
        WHEN ${status}>=500 THEN clock_timestamp()+${Math.max(4000,delay)}*interval '1 millisecond' ELSE '-infinity'::timestamptz END,
      CASE WHEN ${remaining===0} THEN clock_timestamp()+interval '1 hour' ELSE '-infinity'::timestamptz END) WHERE singleton`.execute(this.db);
  }
}
