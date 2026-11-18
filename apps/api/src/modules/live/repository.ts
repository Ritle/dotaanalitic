import {randomUUID} from 'node:crypto';
import {sql,type Db,type ScheduleCacheRow} from '@dota/db';
import {LiveSnapshotSchema} from './contract.js';
export class LiveScheduleRepository{
 constructor(private readonly db:Db){}
 async read(){return (await sql<ScheduleCacheRow>`SELECT c.payload,c.expires_at,
  CASE WHEN c.retry_at>clock_timestamp() THEN c.retry_at END retry_at,
  CASE WHEN c.lease_until>clock_timestamp() THEN c.lease_until END lease_until,c.failure_code,clock_timestamp() AS now
  FROM (SELECT 1) d LEFT JOIN live_schedule_cache c ON c.singleton=true`.execute(this.db)).rows[0]!;}
 async claim(){const token=randomUUID();return this.db.transaction().execute(async tx=>{
  await sql`INSERT INTO live_schedule_cache(singleton) VALUES (true) ON CONFLICT DO NOTHING`.execute(tx);
  const r=await sql`UPDATE live_schedule_cache SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '90 seconds'
   WHERE singleton=true AND (expires_at IS NULL OR expires_at<=clock_timestamp()) AND retry_at<=clock_timestamp()
   AND lease_until<=clock_timestamp() RETURNING singleton`.execute(tx);
  return r.rows.length?token:null;
 });}
 async publish(token:string,input:unknown){const value=LiveSnapshotSchema.parse(input);
  await sql`UPDATE live_schedule_cache SET payload=${JSON.stringify(value)}::jsonb,expires_at=clock_timestamp()+interval '60 seconds',
   retry_at='-infinity',lease_token=NULL,lease_until='-infinity',failure_code=NULL
   WHERE singleton=true AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(this.db);
 }
 async fail(token:string,retryMs=60000){const delay=Number.isFinite(retryMs)?Math.max(60000,Math.ceil(retryMs)):60000;
  await sql`UPDATE live_schedule_cache SET retry_at=clock_timestamp()+${delay}*interval '1 millisecond',lease_token=NULL,
   lease_until='-infinity',failure_code='source_unavailable' WHERE singleton=true AND lease_token=${token}::uuid`.execute(this.db);
 }
}
