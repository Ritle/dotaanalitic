import {ScheduleCacheRepository,SchedulePageRepository,PandaScoreQuotaRepository,type Db} from '@dota/db';
import {PandaScoreClient,PandaScoreError,type PandaScoreBudget} from '@dota/ingestion';
import {ScheduleCacheDataSchema,RostersCacheDataSchema,UpcomingScheduleResponseSchema,UpcomingRostersResponseSchema,
  SchedulePageNumberSchema,SchedulePageCacheDataSchema,SchedulePageResponseSchema,schedulePageEndpoint,
  type SchedulePageResponse,type UpcomingScheduleResponse,type UpcomingRostersResponse} from '@dota/contracts';

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
  private readonly cache:ScheduleCacheRepository;private readonly quota:PandaScoreQuotaRepository;private readonly pages:SchedulePageRepository;
  constructor(db:Db,private readonly token?:string,private readonly fetcher?:(url:URL,init:RequestInit)=>Promise<Response>){
    this.cache=new ScheduleCacheRepository(db);this.quota=new PandaScoreQuotaRepository(db);this.pages=new SchedulePageRepository(db);
  }
  schedule(refresh=false,page=1):Promise<SchedulePageResponse>{
    SchedulePageNumberSchema.parse(page);
    return page===1?this.load('schedule',refresh) as Promise<UpcomingScheduleResponse>:this.loadPage(page,refresh);
  }
  private validPage(payload:unknown,page:number,now:Date){
    const parsed=SchedulePageCacheDataSchema.safeParse(payload);
    return parsed.success&&parsed.data.source.endpoint===schedulePageEndpoint(page)&&parsed.data.source.fetchedAt<=now.toISOString()&&
      (!this.token||!JSON.stringify(parsed.data).includes(this.token.trim()))?parsed.data:null;
  }
  private async cachedSchedules(){
    const first=await this.schedule(),rows=await this.pages.cached();
    const pages=[...(first.snapshot?[first.snapshot]:[]),...rows.flatMap(r=>{const data=this.validPage(r.payload,r.page,r.now);return data?[data]:[];})];
    return pages.sort((a,b)=>b.source.fetchedAt.localeCompare(a.source.fetchedAt));
  }
  async findMatch(id:string){return (await this.cachedSchedules()).flatMap(p=>p.data).find(m=>m.providerMatchId===id);}
  async tournament(id:string,refresh=false):Promise<UpcomingRostersResponse|null>{
    if(!(await this.cachedSchedules()).some(s=>s.data.some(m=>m.tournament.providerTournamentId===id)))return null;
    return this.load('tournament:'+id,refresh) as Promise<UpcomingRostersResponse>;
  }
  private async loadPage(page:number,refresh:boolean):Promise<SchedulePageResponse>{
    if(refresh&&this.token){
      const lease=await this.pages.claim(page);
      if(lease)try{
        const client=new PandaScoreClient({apiToken:this.token,maxRequests:2},{fetch:this.fetcher,budget:new DurablePandaScoreBudget(this.quota)});
        const observation=await client.getUpcomingMatches(page);
        if(JSON.stringify(observation).includes(this.token.trim()))throw Error('credential_echo');
        await this.pages.publish(page,lease,observation);
      }catch(e){await this.pages.fail(page,lease,e instanceof PandaScoreError?e.retryAfterMs??60000:60000);}
    }
    const row=await this.pages.read(page),snapshot=this.validPage(row.payload,page,row.now),configured=Boolean(this.token),refreshing=row.lease_until!==null;
    const reason=!configured?'not_configured':refreshing?'refresh_in_progress':row.failure_code?'source_unavailable':
      row.retry_at?'cooldown':row.payload!==null&&!snapshot?'invalid_cached_data':!snapshot?'not_loaded':null;
    return SchedulePageResponseSchema.parse({snapshot,status:snapshot?(row.expires_at!>row.now?'ready':'stale'):'unavailable',
      computedAt:row.now.toISOString(),expiresAt:row.expires_at?.toISOString()??null,retryAt:row.retry_at?.toISOString()??null,configured,refreshing,reason});
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
          await this.cache.publish(key,lease,data,true);
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
