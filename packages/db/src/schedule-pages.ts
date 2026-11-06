import {createHash,randomUUID} from 'node:crypto';
import {SchedulePageNumberSchema,SchedulePageCacheDataSchema,schedulePageEndpoint} from '@dota/contracts';
import {sql,type Db} from './index.js';
import type {ScheduleCacheRow} from './schedule-cache.js';
const pageNumber=(page:number)=>SchedulePageNumberSchema.refine(n=>n>1).parse(page);
/** Separate storage retains the registered V1 page-one schema and history byte-for-byte. */
export class SchedulePageRepository{
 constructor(private readonly db:Db){}
 async read(page:number):Promise<ScheduleCacheRow>{
  pageNumber(page);
  return (await sql<ScheduleCacheRow>`SELECT c.payload,c.expires_at,CASE WHEN c.retry_at>clock_timestamp() THEN c.retry_at END retry_at,
   CASE WHEN c.lease_until>clock_timestamp() THEN c.lease_until END lease_until,c.failure_code,clock_timestamp() AS now
   FROM (SELECT 1) d LEFT JOIN upcoming_page_cache c ON c.page=${page}`.execute(this.db)).rows[0]!;
 }
 async cached(){return (await sql<{page:number;payload:unknown;now:Date}>`SELECT page,payload,clock_timestamp() AS now
  FROM upcoming_page_cache WHERE payload IS NOT NULL ORDER BY page LIMIT 49`.execute(this.db)).rows;}
 async claim(page:number){
  pageNumber(page);const token=randomUUID();
  return this.db.transaction().execute(async tx=>{
   await sql`INSERT INTO upcoming_page_cache(page) VALUES (${page}) ON CONFLICT DO NOTHING`.execute(tx);
   await sql`SELECT page FROM upcoming_page_cache WHERE page=${page} FOR UPDATE`.execute(tx);
   const r=await sql`UPDATE upcoming_page_cache SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '90 seconds'
    WHERE page=${page} AND (expires_at IS NULL OR expires_at<=clock_timestamp())
    AND retry_at<=clock_timestamp() AND lease_until<=clock_timestamp() RETURNING page`.execute(tx);
   return r.rows.length?token:null;
  });
 }
 async publish(page:number,token:string,payload:unknown){
  pageNumber(page);const snapshot=SchedulePageCacheDataSchema.parse(payload);
  if(snapshot.source.endpoint!==schedulePageEndpoint(page))throw Error('source_endpoint_mismatch');
  const text=JSON.stringify(snapshot),sha=createHash('sha256').update(text).digest('hex');
  await this.db.transaction().execute(async tx=>{
   const r=await sql`UPDATE upcoming_page_cache SET payload=${text}::jsonb,expires_at=clock_timestamp()+interval '5 minutes',
    lease_token=NULL,lease_until='-infinity',retry_at='-infinity',failure_code=NULL
    WHERE page=${page} AND lease_token=${token}::uuid AND lease_until>clock_timestamp() RETURNING page`.execute(tx);
   if(r.rows.length)await sql`INSERT INTO upcoming_page_observations(page,source_endpoint,source_payload_sha256,source_fetched_at,snapshot_sha256,snapshot_text)
    VALUES (${page},${snapshot.source.endpoint},${snapshot.source.payloadSha256},${snapshot.source.fetchedAt},${sha},${text})`.execute(tx);
  });
 }
 async fail(page:number,token:string,retryAfterMs=60000){
  pageNumber(page);const delay=Number.isFinite(retryAfterMs)?Math.max(60000,Math.ceil(retryAfterMs)):60000;
  await sql`UPDATE upcoming_page_cache SET lease_token=NULL,lease_until='-infinity',failure_code='source_unavailable',
   retry_at=clock_timestamp()+${delay}*interval '1 millisecond' WHERE page=${page} AND lease_token=${token}::uuid`.execute(this.db);
 }
}
