import {ScheduleCacheRepository,PandaScoreQuotaRepository,type Db} from '@dota/db';
import {PandaScoreClient,PandaScoreError,type PandaScoreBudget} from '@dota/ingestion';
import {ScheduleCacheDataSchema,RostersCacheDataSchema,UpcomingScheduleResponseSchema,UpcomingRostersResponseSchema,
  type UpcomingScheduleResponse,type UpcomingRostersResponse} from '@dota/contracts';

export class DurablePandaScoreBudget implements PandaScoreBudget{
  constructor(private readonly repository:PandaScoreQuotaRepository,private readonly sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){}
  async beforeRequest(){
    for(let i=0;i<3;i++){
      const p=await this.repository.claim();if(p.allowed)return;
      if(i<2&&p.retryAfterMs<=5000){await this.sleep(p.retryAfterMs+1);continue;}
      throw new PandaScoreError('source_rate_limited',null,null,p.retryAfterMs);
    }
  }
  observe(status:number,retryAfterMs:number|null,remaining:number|null){return this.repository.observe(status,retryAfterMs,remaining);}
}
export class UpcomingService{
  private readonly cache:ScheduleCacheRepository;private readonly quota:PandaScoreQuotaRepository;
  constructor(db:Db,private readonly token?:string,private readonly fetcher?:(url:URL,init:RequestInit)=>Promise<Response>){
    this.cache=new ScheduleCacheRepository(db);this.quota=new PandaScoreQuotaRepository(db);
  }
  schedule(refresh=false):Promise<UpcomingScheduleResponse>{return this.load('schedule',refresh) as Promise<UpcomingScheduleResponse>;}
  async tournament(id:string,refresh=false):Promise<UpcomingRostersResponse|null>{
    const schedule=await this.schedule();
    if(!schedule.snapshot?.data.some(m=>m.tournament.providerTournamentId===id))return null;
    return this.load('tournament:'+id,refresh) as Promise<UpcomingRostersResponse>;
  }
  private async load(key:string,refresh:boolean){
    const schema=key==='schedule'?ScheduleCacheDataSchema:RostersCacheDataSchema;
    if(refresh&&this.token){
      const lease=await this.cache.claim(key);
      if(lease){
        try{
          const client=new PandaScoreClient({apiToken:this.token,maxRequests:2},{fetch:this.fetcher,budget:new DurablePandaScoreBudget(this.quota)});
          const observation=key==='schedule'?await client.getUpcomingMatches():await client.getTournamentRosters(key.slice('tournament:'.length));
          const data=schema.parse(observation);
          if(JSON.stringify(data).includes(this.token.trim()))throw new Error('credential_echo');
          await this.cache.publish(key,lease,data);
        }catch(e){await this.cache.fail(key,lease,e instanceof PandaScoreError?e.retryAfterMs??60000:60000);}
      }
    }
    const row=await this.cache.read(key),parsed=schema.safeParse(row.payload),configured=Boolean(this.token);
    const endpoint=key==='schedule'?'/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20':`/tournaments/${key.slice('tournament:'.length)}/rosters`;
    const valid=parsed.success&&parsed.data.source.endpoint===endpoint&&parsed.data.source.fetchedAt<=row.now.toISOString()&&
      (!this.token||!JSON.stringify(parsed.data).includes(this.token.trim()));
    const snapshot=valid&&parsed.success?parsed.data:null,refreshing=row.lease_until!==null;
    const reason=!configured?'not_configured':refreshing?'refresh_in_progress':row.failure_code?'source_unavailable':
      row.retry_at?'cooldown':row.payload!==null&&!valid?'invalid_cached_data':!snapshot?'not_loaded':null;
    const response={snapshot,status:snapshot?(row.expires_at!>row.now?'ready':'stale'):'unavailable',computedAt:row.now.toISOString(),
      expiresAt:row.expires_at?.toISOString()??null,retryAt:row.retry_at?.toISOString()??null,configured,refreshing,reason};
    return key==='schedule'?UpcomingScheduleResponseSchema.parse(response):UpcomingRostersResponseSchema.parse(response);
  }
}
