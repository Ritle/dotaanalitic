import {RankedContextRequestSchema,RankedContextReportSchema,RANKED_CONTEXT_POLICY,RANKED_PRACTICE_ADAPTER_VERSION,type RankedContextRequest} from '@dota/contracts';
import {RoleProfileRepository,RankedPracticeRepository,RankedContextRepository,sql,type Db} from '@dota/db';
import {RankedContextClient,RankedPracticeSourceError,type RoleProfileBudget} from '@dota/ingestion';
import type {AppConfig} from '../../config.js';
export class RankedContextService{
 readonly repository:RankedContextRepository;
 private readonly identities:RoleProfileRepository;
 private readonly history:RankedPracticeRepository;
 constructor(private readonly db:Db,private readonly config:AppConfig,private readonly budget:()=>RoleProfileBudget,private readonly fetcher?:typeof fetch){
  this.repository=new RankedContextRepository(db);this.identities=new RoleProfileRepository(db);this.history=new RankedPracticeRepository(db);
 }
 private async scope(request:RankedContextRequest){
  if(!(await sql`SELECT id FROM players WHERE id=${request.playerId}::bigint`.execute(this.db)).rows.length)throw new RankedPracticeSourceError('invalid_player');
  const identity=(await this.identities.identities([request.playerId]))[0]!,accountId=identity.identityStatus==='verified'?identity.accountIds[0]!:null,
   revision=(await sql<{revision:string}>`SELECT revision::text FROM identity_registry_state WHERE singleton`.execute(this.db)).rows[0]!.revision;
  let reason:string|null=!accountId?'identity_'+identity.identityStatus:BigInt(accountId)>4294967295n?'invalid_account':!this.config.RANKED_PRACTICE_ENABLED?'disabled':!this.config.STRATZ_API_TOKEN?'not_configured':null;
  const history=!reason&&accountId?await this.history.read('opendota',accountId):null,o=history?.observation??null;
  if(!reason&&(!o||history?.id!==request.parentObservationId||history.playerId!==request.playerId||o.adapterVersion!==RANKED_PRACTICE_ADAPTER_VERSION||o.coverage.conflicts))reason='parent_changed';
  if(!reason&&o?.maps.length===0)reason='no_maps';
  return {accountId,revision,reason,observation:reason?null:o};
 }
 async report(input:RankedContextRequest){
  const request=RankedContextRequestSchema.parse(input);let scope=await this.scope(request);
  if(!scope.reason&&scope.accountId&&scope.observation&&request.refresh){
   const ids=this.repository.selectMaps(scope.observation.maps).map(m=>m.matchId),cached=await this.repository.cached(scope.accountId,ids);
   if(ids.some(id=>!cached.get(id)?.fresh)){
    const token=await this.repository.claim(scope.accountId);
    if(token)try{
     const fresh=await this.repository.cached(scope.accountId,ids),pending=ids.filter(id=>!fresh.get(id)?.fresh),client=new RankedContextClient(this.budget(),this.config.STRATZ_API_TOKEN!,this.fetcher);
     for(let i=0;i<pending.length;i+=4){
      const current=await this.scope(request);if(current.reason||current.accountId!==scope.accountId)throw new RankedPracticeSourceError(current.reason??'identity_changed');
      const result=await client.lookup(scope.accountId,pending.slice(i,i+4)),serialized=JSON.stringify(result);
      if([this.config.STRATZ_API_TOKEN,this.config.PANDASCORE_API_TOKEN,process.env.OPENDOTA_API_KEY].some(s=>s&&serialized.includes(s)))throw new RankedPracticeSourceError('source_invalid_payload');
      if(!await this.repository.publish(request.playerId,request.parentObservationId,scope.accountId,token,result.receipt,result.rawBody))throw new RankedPracticeSourceError('refresh_expired');
     }
     await this.repository.finish(scope.accountId,token);
    }catch(e){
     const code=e instanceof RankedPracticeSourceError?e.code:e instanceof Error&&e.message==='ranked_context_parent_changed'?'parent_changed':e instanceof Error&&e.message==='ranked_context_identity_changed'?'identity_changed':'source_unavailable';
     await this.repository.fail(scope.accountId,token,code,e instanceof RankedPracticeSourceError?e.retryMs:60000);
    }
   }
   scope=await this.scope(request);
  }
  const base={playerId:request.playerId,parentObservationId:request.parentObservationId,accountId:scope.accountId,identityRevision:scope.revision,provider:'stratz' as const,policyVersion:RANKED_CONTEXT_POLICY,snapshotAt:new Date().toISOString()};
  if(scope.reason||!scope.accountId||!scope.observation)return RankedContextReportSchema.parse({...base,status:'unavailable',reason:scope.reason,retryAt:null,parentFromAt:null,parentCutoffAt:null,parentGames:0,selectedMaps:0,matchedMaps:0,maps:[]});
  const o=scope.observation,ids=this.repository.selectMaps(o.maps).map(m=>m.matchId),cached=await this.repository.cached(scope.accountId,ids),maps=this.repository.describe(o.maps,cached),state=await this.repository.state(scope.accountId),matchedMaps=maps.filter(m=>m.status==='matched').length;
  const status=maps.every(m=>m.status==='not_loaded')?'not_loaded':matchedMaps===maps.length&&maps.every(m=>!m.stale)?'ready':'partial';
  return RankedContextReportSchema.parse({...base,status,reason:state.reason,retryAt:state.retryAt,parentFromAt:o.fromAt,parentCutoffAt:o.cutoffAt,parentGames:o.maps.length,selectedMaps:maps.length,matchedMaps,maps});
 }
}
