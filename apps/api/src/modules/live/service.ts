import {PandaScoreQuotaRepository,type Db} from '@dota/db';
import {PandaScoreError} from '@dota/ingestion';
import {DurablePandaScoreBudget} from '../upcoming/service.js';
import {LiveResponseSchema,LiveSnapshotSchema} from './contract.js';
import {LiveScheduleRepository} from './repository.js';
import {PandaScoreLiveClient} from './provider.js';
export class LiveScheduleService{
 private readonly cache:LiveScheduleRepository;
 constructor(private readonly db:Db,private readonly token?:string,private readonly fetcher?:(url:URL,init:RequestInit)=>Promise<Response>){this.cache=new LiveScheduleRepository(db);}
 async read(refresh=false){
  if(refresh&&this.token){const lease=await this.cache.claim();if(lease)try{
   const client=new PandaScoreLiveClient({apiToken:this.token,maxRequests:2},{fetch:this.fetcher,budget:new DurablePandaScoreBudget(new PandaScoreQuotaRepository(this.db))});
   const observed=await client.getRunningMatches();if(JSON.stringify(observed).includes(this.token.trim()))throw Error('credential_echo');
   await this.cache.publish(lease,observed);
  }catch(e){await this.cache.fail(lease,e instanceof PandaScoreError?e.retryAfterMs??60000:60000);}}
  const row=await this.cache.read(),parsed=LiveSnapshotSchema.safeParse(row.payload);
  const snapshot=parsed.success&&parsed.data.source.fetchedAt<=row.now.toISOString()&&(!this.token||!JSON.stringify(parsed.data).includes(this.token.trim()))?parsed.data:null;
  const configured=!!this.token,refreshing=row.lease_until!==null;
  return LiveResponseSchema.parse({snapshot,configured,refreshing,computedAt:row.now.toISOString(),expiresAt:row.expires_at?.toISOString()??null,retryAt:row.retry_at?.toISOString()??null,
   status:snapshot?(row.expires_at!>row.now?'ready':'stale'):'unavailable',
   reason:!configured?'not_configured':refreshing?'refresh_in_progress':row.failure_code?'source_unavailable':row.retry_at?'cooldown':row.payload&&!snapshot?'invalid_cached_data':!snapshot?'not_loaded':null});
 }
}
