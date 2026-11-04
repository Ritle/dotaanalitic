import {RoleProfileRepository,RoleSuggestionRepository,resolveRoleProfiles,PandaScoreQuotaRepository,type Db} from '@dota/db';
import {RoleProfilesRequestSchema,type RoleProfilesReport,type RoleProfilesRequest} from '@dota/contracts';
import {RoleProfileClient,RoleProfileSourceError,type RoleProfileBudget} from '@dota/ingestion';
import {DurablePandaScoreBudget} from '../upcoming/service.js';
import type {AppConfig} from '../../config.js';
export class RoleProfileService{
  readonly repository:RoleProfileRepository;
  private readonly history:RoleSuggestionRepository;
  constructor(db:Db,private readonly config:AppConfig,private readonly fetcher?:typeof fetch){this.repository=new RoleProfileRepository(db);this.history=new RoleSuggestionRepository(db);this.pandaQuota=new PandaScoreQuotaRepository(db);}
  private readonly pandaQuota:PandaScoreQuotaRepository;
  private budget(provider:'stratz'|'pandascore'):RoleProfileBudget{
    if(provider==='pandascore'){
      const budget=new DurablePandaScoreBudget(this.pandaQuota);
      return {beforeRequest:()=>budget.beforeRequest(),observe:(status,retry,headers)=>{
        const raw=headers.get('x-rate-limit-remaining');return budget.observe(status,retry,raw&&/^\d+$/.test(raw)?Number(raw):null);
      }};
    }
    return {beforeRequest:async()=>{
      for(let i=0;i<3;i++){const wait=await this.repository.claimStratz();if(!wait)return;if(wait>1500||i===2)throw new RoleProfileSourceError('source_rate_limited',wait);await new Promise(r=>setTimeout(r,wait+1));}
    },observe:async(status,retry,headers)=>{
      const minute=headers.get('x-ratelimit-remaining-minute'),day=headers.get('x-ratelimit-remaining-day');
      const untilDay=86400000-(Date.now()%86400000);
      await this.repository.blockStratz(Math.max(status===429?retry??60000:status>=500?retry??10000:0,minute==='0'?60000:0,day==='0'?untilDay:0));
    }};
  }
  async report(owner:string,input:RoleProfilesRequest):Promise<RoleProfilesReport>{
    const request=RoleProfilesRequestSchema.parse(input),cutoffAt=request.cutoffAt??new Date().toISOString();
    const [binding,identities,history,teamHistory]=await Promise.all([this.repository.binding(owner,request.teamId),this.repository.identities(request.playerIds),
      this.history.suggest({playerIds:request.playerIds,cutoffAt}),this.history.suggest({playerIds:request.playerIds,cutoffAt},request.teamId)]);
    const configured={enabled:this.config.ROLE_PROFILES_ENABLED,stratz:Boolean(this.config.STRATZ_API_TOKEN),pandascore:Boolean(this.config.PANDASCORE_API_TOKEN)};
    const keys=[...new Set(identities.filter(i=>i.identityStatus==='verified').flatMap(i=>i.accountIds.map(a=>'stratz:player:'+a)))];
    if(binding.binding.pandaTournamentId)keys.push('pandascore:roster:'+binding.binding.pandaTournamentId);
    const sources:RoleProfilesReport['sources']=[];
    for(const key of keys){
      const provider=key.startsWith('stratz:')?'stratz':'pandascore',token=provider==='stratz'?this.config.STRATZ_API_TOKEN:this.config.PANDASCORE_API_TOKEN;
      const canUse=configured.enabled&&Boolean(token);let cached=await this.repository.cache(key);
      const sanitize=()=>{if(cached.observation&&[this.config.STRATZ_API_TOKEN,this.config.PANDASCORE_API_TOKEN].some(t=>t&&JSON.stringify(cached.observation).includes(t)))cached={observation:null,fresh:false,reason:'invalid_cached_data'};};
      sanitize();
      if(request.refreshProfiles&&canUse){
        const lease=await this.repository.claim(key);
        if(lease)try{const observation=await new RoleProfileClient(provider,token!,this.budget(provider),this.fetcher).read(key.split(':')[2]!);await this.repository.publish(key,lease,observation);}
        catch(e){await this.repository.fail(key,lease,e instanceof RoleProfileSourceError?e.code:'source_unavailable',e instanceof RoleProfileSourceError?e.retryMs:60000);}
        cached=await this.repository.cache(key);
        sanitize();
      }
      // Disabled/missing-token data remains inspectable but cannot drive auto assignment.
      sources.push({provider,sourceKey:key,status:canUse&&cached.fresh?'ready':cached.observation?'stale':'unavailable',
        reason:!configured.enabled?'disabled':!token?'not_configured':cached.reason,fetchedAt:cached.observation?.fetchedAt??null,observation:cached.observation});
    }
    return resolveRoleProfiles({teamId:request.teamId,snapshotAt:new Date().toISOString(),configured,binding,sources},history,teamHistory,identities);
  }
}
