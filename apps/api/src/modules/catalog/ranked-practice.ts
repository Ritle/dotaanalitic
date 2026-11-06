import type {FastifyInstance} from 'fastify';
import {RankedPracticeRequestSchema,RankedPracticeReportSchema,RankedContextRequestSchema,type RankedPracticeRequest,type RankedProvider} from '@dota/contracts';
import {RoleProfileRepository,RankedPracticeRepository,sql,type Db} from '@dota/db';
import {RankedPracticeClient,RankedPracticeSourceError,PostgresProviderBudget,OpenDotaError,type RoleProfileBudget} from '@dota/ingestion';
import type {AppConfig} from '../../config.js';
import {RankedContextService} from './ranked-context.js';
export class RankedPracticeService{
 readonly repository:RankedPracticeRepository;
 readonly context:RankedContextService;
 private readonly identities:RoleProfileRepository;
 constructor(private readonly db:Db,private readonly config:AppConfig,private readonly fetcher?:typeof fetch){this.repository=new RankedPracticeRepository(db);this.identities=new RoleProfileRepository(db);this.context=new RankedContextService(db,config,()=>this.budget('stratz'),fetcher);}
 private budget(provider:RankedProvider):RoleProfileBudget{
  if(provider==='opendota'){
   const b=new PostgresProviderBudget(this.db,{rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)});
   return {beforeRequest:()=>b.beforeRequest(),observe:(status,retry,h)=>{
    const remaining=(name:string)=>{const raw=h.get('x-rate-limit-remaining-'+name);return raw!==null&&/^\d+$/.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):null;};
    return b.observe(status,retry,{minute:remaining('minute'),day:remaining('day'),month:remaining('month')});
   }};
  }
  return {beforeRequest:async()=>{for(let i=0;i<3;i++){const wait=await this.identities.claimStratz();if(!wait)return;if(wait>1500||i===2)throw new RankedPracticeSourceError('source_rate_limited',wait);await new Promise(r=>setTimeout(r,wait+1));}},
   observe:async(status,retry,h)=>{const now=Date.now(),zero=(name:string)=>h.get('x-ratelimit-remaining-'+name)==='0';
    await this.identities.blockStratz(Math.max(status===429?retry??60000:status>=500?retry??10000:0,zero('second')?1000:0,zero('minute')?60000:0,zero('hour')?3600000-now%3600000:0,zero('day')?86400000-now%86400000:0));}};
 }
 async report(input:RankedPracticeRequest){
  const request=RankedPracticeRequestSchema.parse(input);
  if(!(await sql`SELECT id FROM players WHERE id=${request.playerId}::bigint`.execute(this.db)).rows.length)throw new RankedPracticeSourceError('invalid_player');
  const identity=(await this.identities.identities([request.playerId]))[0]!,accountId=identity.identityStatus==='verified'?identity.accountIds[0]!:null;
  const identityRevision=(await sql<{revision:string}>`SELECT revision::text FROM identity_registry_state WHERE singleton`.execute(this.db)).rows[0]!.revision;
  const base={playerId:request.playerId,provider:request.provider,accountId,identityStatus:identity.identityStatus,identityRevision,snapshotAt:new Date().toISOString(),statisticsEnabled:false as const};
  const unavailable=(reason:string)=>RankedPracticeReportSchema.parse({...base,status:identity.identityStatus==='conflict'?'conflict':'unavailable',stale:false,reason,retryAt:null,observationId:null,observationIdentityRevision:null,observation:null});
  if(!accountId)return unavailable('identity_'+identity.identityStatus);
  if(BigInt(accountId)>4294967295n)return unavailable('invalid_account');
  const enabled=this.config.RANKED_PRACTICE_ENABLED,configured=request.provider!=='stratz'||Boolean(this.config.STRATZ_API_TOKEN);
  if(enabled&&configured&&request.refresh){
   const lease=await this.repository.claim(request.provider,accountId);
   if(lease)try{
    const token=request.provider==='stratz'?this.config.STRATZ_API_TOKEN:process.env.OPENDOTA_API_KEY;
    const result=await new RankedPracticeClient(request.provider,this.budget(request.provider),{token},this.fetcher).read(accountId);
    const heroIds=[...new Set(result.observation.maps.map(m=>m.heroId))];
    const knownHeroes=new Set((await sql<{id:string}>`SELECT id::text FROM heroes WHERE id=ANY(${heroIds}::bigint[])`.execute(this.db)).rows.map(r=>r.id));
    const missingHeroes=result.observation.maps.filter(m=>!knownHeroes.has(m.heroId)).length;
    if(missingHeroes){result.observation.maps=result.observation.maps.filter(m=>knownHeroes.has(m.heroId));result.observation.coverage.excluded.unknown_hero=missingHeroes;}
    const serialized=JSON.stringify(result);if([this.config.STRATZ_API_TOKEN,this.config.PANDASCORE_API_TOKEN,process.env.OPENDOTA_API_KEY].some(secret=>secret&&serialized.includes(secret)))throw new RankedPracticeSourceError('source_invalid_payload');
    // Recheck identity after the network read; do not publish under a changed mapping.
    const current=(await this.identities.identities([request.playerId]))[0]!;
    if(current.identityStatus!=='verified'||current.accountIds[0]!==accountId)throw new RankedPracticeSourceError('identity_changed');
    await this.repository.publish(request.playerId,request.provider,accountId,lease,result.observation,result.rawBodies);
   }catch(e){const error=e instanceof RankedPracticeSourceError?e:e instanceof OpenDotaError?new RankedPracticeSourceError(e.code,e.retryAfterMs??60000):new RankedPracticeSourceError('source_unavailable');await this.repository.fail(request.provider,accountId,lease,error.code,error.retryMs);}
  }
  const cached=await this.repository.read(request.provider,accountId);
  if(!enabled||!configured)return unavailable(!enabled?'disabled':'not_configured');
  const finalIdentity=(await this.identities.identities([request.playerId]))[0]!;
  if(finalIdentity.identityStatus!=='verified'||finalIdentity.accountIds[0]!==accountId)
   return RankedPracticeReportSchema.parse({...base,snapshotAt:new Date().toISOString(),accountId:null,identityStatus:finalIdentity.identityStatus,
    status:finalIdentity.identityStatus==='conflict'?'conflict':'unavailable',stale:false,reason:'identity_changed',retryAt:null,observationId:null,observationIdentityRevision:null,observation:null});
  if(cached.playerId!==null&&cached.playerId!==request.playerId)return unavailable('identity_changed');
  const o=cached.observation;
  let status:'ready'|'partial'|'empty'|'not_loaded'|'unavailable'|'conflict';
  if(!o)status=cached.reason==='not_loaded'?'not_loaded':'unavailable';
  else if(o.coverage.conflicts)status='conflict';
  else if(!cached.fresh||o.coverage.pagination!=='exhausted'||Object.keys(o.coverage.excluded).length)status='partial';
  else status=o.maps.length?'ready':'empty';
  const heroSummary=o&&cached.id?await this.repository.heroSummary(cached.id,o):null;
  return RankedPracticeReportSchema.parse({...base,snapshotAt:new Date().toISOString(),status,stale:Boolean(o&&!cached.fresh),reason:cached.reason,retryAt:cached.retryAt,observationId:cached.id,observationIdentityRevision:cached.identityRevision,observation:o,statisticsEnabled:heroSummary!==null,heroSummary});
 }
}
export function registerRankedPractice(app:FastifyInstance,service:RankedPracticeService){
 app.post('/api/v1/ranked-practice/context',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>{
  const parsed=RankedContextRequestSchema.safeParse(request.body),invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите игрока и сохранённую рейтинговую историю OpenDota.',requestId:request.id}});
  if(!parsed.success)return invalid();
  try{return await service.context.report(parsed.data);}catch(e){if(e instanceof RankedPracticeSourceError&&e.code==='invalid_player')return invalid();throw e;}
 });
 app.post('/api/v1/ranked-practice',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>{
  const parsed=RankedPracticeRequestSchema.safeParse(request.body);
  const invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите существующего игрока и источник рейтинговой истории.',requestId:request.id}});
  if(!parsed.success)return invalid();
  try{return await service.report(parsed.data);}catch(e){if(e instanceof RankedPracticeSourceError&&e.code==='invalid_player')return invalid();throw e;}
 });
}
