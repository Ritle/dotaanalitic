import {randomUUID,createHash} from 'node:crypto';
import {IdentityProvisioner,IdentityProvisionError,RosterCatalogueRepository,RosterCatalogueError,RoleProfileRepository,PlayerCatalogueRepository,type Db} from '@dota/db';
import {catalogueCandidates,catalogueDirectoryCandidates,catalogueTeamCandidate,catalogueAccountQuery,catalogueProfileCandidate,prepareRosterReviews,CatalogueObservationSchema,createProviderRuntime,
 OpenDotaTeamDirectoryClient,OpenDotaPlayerSearchClient,discoveryKey,discoveryQuery,discoveryCandidates,preferExactPlayerCandidates,rankPlayerCandidatesByHistory,PostgresProviderBudget,type CatalogueObservation} from '@dota/ingestion';
import {CatalogIdSchema,RosterCatalogueStateSchema,RosterCatalogueSearchResultSchema,RosterCataloguePreparedSchema,type RosterCatalogueApply,type RosterCataloguePrepared} from '@dota/contracts';
import {UpcomingService} from './service.js';
export type CatalogueProvider=(key:string,query?:string)=>Promise<unknown>;
export class RosterCatalogueService{
 readonly repository:RosterCatalogueRepository;
 private readonly pending=new Map<string,Promise<CatalogueObservation>>();
 constructor(private readonly db:Db,private readonly upcoming:UpcomingService,private readonly provider:CatalogueProvider){this.repository=new RosterCatalogueRepository(db);}
 private async context(matchId:string){const match=await this.upcoming.findMatch(matchId);
  if(!match||match.opponents.length!==2||match.status!=='not_started'||match.scheduledAt!==null&&match.scheduledAt<=new Date().toISOString())throw new RosterCatalogueError('invalid');
  const rosters=await this.upcoming.tournament(match.tournament.providerTournamentId);return {match,rosters};
 }
 async state(owner:string,matchId:string){const {match,rosters}=await this.context(matchId);
  const teams=await Promise.all(match.opponents.map(async t=>{const players=rosters?.snapshot?.data.find(r=>r.providerTeamId===t.providerTeamId)?.players??[];
   const binding=await this.repository.latest(owner,t.providerTeamId);
   if(binding)binding.usable=binding.usable&&binding.players.every(p=>players.some(r=>r.providerPlayerId===p.providerPlayerId));
   const linkedPlayers=await Promise.all(players.map(async p=>({...p,linkToken:(await new PlayerCatalogueRepository(this.db).link(owner,p.providerPlayerId)).token})));
   return {...t,players:linkedPlayers,binding};}));
  return RosterCatalogueStateSchema.parse({matchId,rosterSha256:rosters?.snapshot?.source.payloadSha256??null,rosterFetchedAt:rosters?.snapshot?.source.fetchedAt??null,teams});
 }
 private source(key:string,query?:string):Promise<CatalogueObservation>{const pending=this.pending.get(key);if(pending)return pending;
  const operation=this.readSource(key,query).finally(()=>{this.pending.delete(key);});this.pending.set(key,operation);return operation;}
 private async readSource(key:string,query?:string):Promise<CatalogueObservation>{const cached=await this.repository.cached(key);
  if(cached?.fresh)return CatalogueObservationSchema.parse(cached.observation);
  const lease=await this.repository.claim(key);if(!lease){const ready=await this.repository.cached(key);if(ready?.fresh)return CatalogueObservationSchema.parse(ready.observation);throw new RosterCatalogueError('source_unavailable');}
  try{const observation=CatalogueObservationSchema.parse(await this.provider(key,query));
   // Validate raw hash and registry/account structure before caching or exposing candidates.
   if(key==='registry')catalogueCandidates(observation,'players','');
   else if(key==='directory')catalogueDirectoryCandidates(observation,'');
   else if(key.startsWith('search:'))discoveryCandidates(observation,query!);
   else if(key.startsWith('player:'))catalogueProfileCandidate(observation,key.slice(7));
   else catalogueTeamCandidate(observation,key.slice(5));
   await this.repository.publish(key,lease,observation);return observation;
  }catch{await this.repository.fail(key,lease);throw new RosterCatalogueError('source_unavailable');}
 }
 private async players(query:string,external=true,exactFirst=false){
  if(!query.trim())return RosterCatalogueSearchResultSchema.parse({items:[],source:'local',fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update('[]').digest('hex'),registrySha256:null});
  // Provider roster names, including numeric nicknames, are never numeric account queries.
  const local=new PlayerCatalogueRepository(this.db),account=exactFirst?null:catalogueAccountQuery(query),localItems=await local.search(account??query),items=rankPlayerCandidatesByHistory(account?localItems.filter(p=>p.id===account):exactFirst?preferExactPlayerCandidates(localItems,query):localItems,query);
  if(items.length)return RosterCatalogueSearchResultSchema.parse({items,source:'local',fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(JSON.stringify(items)).digest('hex'),registrySha256:null});
  let registry:CatalogueObservation|null=null,unavailable=false;
  try{registry=await this.source('registry');}catch{unavailable=true;}
  const discovered=registry?catalogueCandidates(registry,'players',account??query):[],found=rankPlayerCandidatesByHistory(account?discovered.filter(p=>p.id===account):exactFirst?preferExactPlayerCandidates(discovered,query):discovered,query);
  if(account&&!found.some(p=>p.id===account)){const profile=await this.source('player:'+account);
   return RosterCatalogueSearchResultSchema.parse({items:[catalogueProfileCandidate(profile,account)],source:'opendota',sourceEndpoint:profile.source.endpoint,
    fetchedAt:profile.source.fetchedAt,payloadSha256:profile.source.payloadSha256,registrySha256:registry?.source.payloadSha256??null});}
  let observation=registry,results=found;
  if(!results.length&&!account&&external&&query.trim().length>=2&&!query.includes('://'))try{
   observation=await this.source(discoveryKey(query),discoveryQuery(query));results=discoveryCandidates(observation,query);
  }catch{unavailable=true;}
  const now=new Date().toISOString();
  return RosterCatalogueSearchResultSchema.parse({items:results,source:observation?'opendota':'local',sourceEndpoint:observation?.source.endpoint,
   fetchedAt:observation?.source.fetchedAt??now,payloadSha256:observation?.source.payloadSha256??createHash('sha256').update('[]').digest('hex'),registrySha256:registry?.source.payloadSha256??null,
   ...(unavailable?{warning:'source_unavailable'}:!external&&!results.length?{warning:'external_search_deferred'}:{})});
 }
 async prepare(owner:string,matchId:string,externalSearch=true){
  const state=await this.state(owner,matchId),local=new PlayerCatalogueRepository(this.db);
  const result:RosterCataloguePrepared={matchId,rosterSha256:state.rosterSha256,registrySha256:null,preparedAt:new Date().toISOString(),teams:[]};
  // Bounded cold lookup: at most three distinct external name searches per preparation.
  let external=externalSearch?3:0;
  for(const team of state.teams){const prepared:RosterCataloguePrepared['teams'][number]={providerTeamId:team.providerTeamId,players:[]};
   for(const p of team.players){const link=await local.link(owner,p.providerPlayerId),cards=await local.cards(link.rows.map(r=>r.playerId));
    if(link.rows.length){const valid=link.rows.length===1&&cards.length===1&&cards[0]!.id===link.rows[0]!.accountId;
     prepared.players.push({...p,linkToken:link.token,status:valid?'linked':'conflict',candidates:cards});continue;}
    let search;try{search=await this.players(p.name??'',external>0,true);}catch{prepared.players.push({...p,linkToken:link.token,status:'source_unavailable',candidates:[]});continue;}
    if(search.sourceEndpoint?.startsWith('/search')||search.warning==='source_unavailable')external--;
    if(search.registrySha256)result.registrySha256=search.registrySha256;
    prepared.players.push({...p,linkToken:link.token,status:search.items.length>1?'ambiguous':search.items.length===1?'suggested':search.warning?'source_unavailable':'not_found',...(search.warning?{reason:search.warning}:{}),candidates:search.items});
   }result.teams.push(prepared);
  }
  return RosterCataloguePreparedSchema.parse(result);
 }
 async search(matchId:string,kind:'teams'|'players',query:string){await this.context(matchId);
  if(kind==='players')return this.players(query);
  const numeric=CatalogIdSchema.safeParse(query),key=numeric.success?'team:'+numeric.data:'directory',observation=await this.source(key);
  const candidate=kind==='teams'&&numeric.success?catalogueTeamCandidate(observation,numeric.data):null;
  const items=numeric.success?(candidate?[candidate]:[]):catalogueDirectoryCandidates(observation,query);
  return RosterCatalogueSearchResultSchema.parse({items,source:'opendota',sourceEndpoint:observation.source.endpoint,fetchedAt:observation.source.fetchedAt,payloadSha256:observation.source.payloadSha256});}
 async apply(owner:string,matchId:string,request:RosterCatalogueApply){
  const {match}=await this.context(matchId);if(!match.opponents.some(t=>t.providerTeamId===request.providerTeamId))throw new RosterCatalogueError('invalid');
  // Serialize preparation across processes without holding a pooled connection during HTTP.
  const lease=await this.repository.prepareLease(owner,request.providerTeamId);
  try{return await this.applySelected(owner,matchId,request,lease);}finally{await this.repository.releasePreparation(owner,request.providerTeamId,lease);}
 }
 private async applySelected(owner:string,matchId:string,request:RosterCatalogueApply,lease:string){
  let {match,rosters}=await this.context(matchId);const team=rosters?.snapshot?.data.find(t=>t.providerTeamId===request.providerTeamId);
  if(!match.opponents.some(t=>t.providerTeamId===request.providerTeamId)||!team||!request.players.every(p=>team.players.some(r=>r.providerPlayerId===p.providerPlayerId)))throw new RosterCatalogueError('invalid');
  const replay=await this.repository.replay(owner,request);if(replay)return replay;
  // Saving authorizes one bounded refresh of a stale roster; changed bytes still require owner review.
  if(rosters?.status==='stale')rosters=await this.upcoming.tournament(match.tournament.providerTournamentId,true);
  if(rosters?.status!=='ready'||rosters.snapshot?.source.payloadSha256!==request.rosterSha256)throw new RosterCatalogueError('source_changed');
  if(await this.repository.revision(owner,request.providerTeamId)!==request.expectedRevision)throw new RosterCatalogueError('conflict');
  const local=new PlayerCatalogueRepository(this.db);await local.checkLinks(owner,request);
  const localCards=await local.cards(request.players.flatMap(p=>p.localPlayerId?[p.localPlayerId]:[]));
  if(request.players.some(p=>p.localPlayerId&&!localCards.some(c=>c.localPlayerId===p.localPlayerId&&c.id===p.accountId)))throw new RosterCatalogueError('conflict');
  const registry=request.registrySha256?await this.source('registry'):null;if(registry&&registry.source.payloadSha256!==request.registrySha256)throw new RosterCatalogueError('source_changed');
  // Organization identity comes from its own numeric profile, not players' current-membership fields.
  const panda=request.teamProvider==='pandascore';if(panda&&(request.teamId!==request.providerTeamId||!team.name?.trim()))throw new RosterCatalogueError('invalid');
  const previous=await this.repository.latest(owner,request.providerTeamId),previousSource=previous?.source.team;
  const reusedTeam=previousSource?.provider===(panda?'pandascore':'opendota')&&previousSource.externalTeamId===request.teamId?previous:null;
  const teamSource=panda||reusedTeam?null:await this.source('team:'+request.teamId);
  if(teamSource&&teamSource.source.endpoint!==`/teams/${request.teamId}`)throw new RosterCatalogueError('source_changed');
  const profiles:CatalogueObservation[]=[];for(const p of request.players.filter(p=>p.profileSha256&&!p.localPlayerId)){
   const profile=await this.source('player:'+p.accountId);if(profile.source.payloadSha256!==p.profileSha256)throw new RosterCatalogueError('source_changed');profiles.push(profile);
  }
  let reviews;try{reviews=prepareRosterReviews(registry,teamSource,request.players,profiles,new Date().toISOString());}catch{throw new RosterCatalogueError('invalid');}
  const provisioner=new IdentityProvisioner(this.db),plans=[];
  for(const review of reviews){const plan=await provisioner.preview(review);if(plan.status==='blocked')throw new RosterCatalogueError('conflict');plans.push({review,plan});}
  // Re-preview after each batch: identity revision changes, numeric proof never does.
  const appliedRows:Awaited<ReturnType<IdentityProvisioner['preview']>>['rows']=[];
  for(const {review} of plans){const plan=await provisioner.preview(review);if(plan.status==='blocked')throw new RosterCatalogueError('conflict');
   try{const applied=await provisioner.apply(review,plan.fingerprint);appliedRows.push(...applied.planAfter.rows);}catch(e){if(e instanceof IdentityProvisionError)throw new RosterCatalogueError('conflict');throw e;}}
  const localTeam=reusedTeam?{id:reusedTeam.teamId,name:reusedTeam.teamName}:panda?await this.repository.pandaTeam(request.providerTeamId,team.name!,{fetchedAt:rosters.snapshot!.source.fetchedAt,payloadSha256:request.rosterSha256}):
   await this.repository.openDotaTeam(request.teamId,catalogueTeamCandidate(teamSource,request.teamId)!.name,
    null,teamSource!.source.fetchedAt);
  await this.repository.checkPreparation(owner,request.providerTeamId,lease);
  const players=request.players.map(p=>{const row=appliedRows.find(r=>r.accountId===p.accountId),card=localCards.find(c=>c.id===p.accountId);
   return {...p,playerId:card?.localPlayerId??row!.playerId!,name:card?.name??row!.alias,proMaps:0,identityStatus:'verified' as const};});
  // This owner association supports current role hints only, never historical identity evidence.
  const roleRepo=new RoleProfileRepository(this.db),old=await roleRepo.binding(owner,localTeam.id);
  const roleBinding={...old.binding,pandaTournamentId:match.tournament.providerTournamentId,pandaTeamId:request.providerTeamId,
   pandaPlayers:players.map(p=>({playerId:p.playerId,providerPlayerId:p.providerPlayerId}))};
  if(JSON.stringify(old.binding)!==JSON.stringify(roleBinding))await roleRepo.saveBinding(owner,localTeam.id,{requestId:randomUUID(),expectedRevision:old.revision,binding:roleBinding,confirmedByOwner:true});
  const localSnapshot=localCards.map(c=>({...c,aliases:undefined}));
  const source=registry?.source??profiles[0]?.source??{fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(JSON.stringify(localSnapshot)).digest('hex')};
  return this.repository.save(owner,request,{providerTeamId:request.providerTeamId,teamId:localTeam.id,teamName:localTeam.name,
   revision:request.expectedRevision+1,recordedAt:new Date().toISOString(),players,usable:true,
   source:{provider:registry||profiles.length?'opendota':'local',fetchedAt:source.fetchedAt,payloadSha256:source.payloadSha256,
    ...(localSnapshot.length?{localCards:localSnapshot}:{}),
    rosterFetchedAt:rosters.snapshot!.source.fetchedAt,rosterSha256:request.rosterSha256,
    ...(profiles.length?{profiles:profiles.map(p=>({accountId:p.source.endpoint.slice(9),fetchedAt:p.source.fetchedAt,payloadSha256:p.source.payloadSha256}))}:{}),
    team:reusedTeam?previousSource!:{provider:panda?'pandascore':'opendota',externalTeamId:request.teamId,fetchedAt:panda?rosters.snapshot!.source.fetchedAt:teamSource!.source.fetchedAt,
     payloadSha256:panda?request.rosterSha256:teamSource!.source.payloadSha256}}},team.players);
 }
}
export const liveCatalogueProvider=(databaseUrl:string):CatalogueProvider=>async (key,query)=>{
 const runtime=createProviderRuntime({...process.env,DATABASE_URL:databaseUrl},3);
 try{
  if(key.startsWith('search:')){if(!query||discoveryKey(query)!==key)throw new RosterCatalogueError('invalid');
   return await new OpenDotaPlayerSearchClient(new PostgresProviderBudget(runtime.db,{rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)}),{apiKey:process.env.OPENDOTA_API_KEY}).read(query);}
  if(key==='directory')return await new OpenDotaTeamDirectoryClient(new PostgresProviderBudget(runtime.db,{rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),
   daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)}),{apiKey:process.env.OPENDOTA_API_KEY}).read();
  return key==='registry'?await runtime.client.getProPlayers():key.startsWith('player:')?await runtime.client.getPlayer(key.slice(7)):await runtime.client.getTeam(key.slice(5));
 }finally{await runtime.close();}
};
