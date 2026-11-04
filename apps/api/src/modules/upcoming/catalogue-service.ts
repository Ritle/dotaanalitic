import {randomUUID} from 'node:crypto';
import {IdentityProvisioner,IdentityProvisionError,RosterCatalogueRepository,RosterCatalogueError,RoleProfileRepository,sql,type Db} from '@dota/db';
import {catalogueCandidates,prepareRosterCatalogueSelection,CatalogueObservationSchema,createProviderRuntime,type CatalogueObservation} from '@dota/ingestion';
import {RosterCatalogueStateSchema,RosterCatalogueSearchResultSchema,type RosterCatalogueApply} from '@dota/contracts';
import {UpcomingService} from './service.js';
export type CatalogueProvider=(key:string)=>Promise<unknown>;
export class RosterCatalogueService{
 readonly repository:RosterCatalogueRepository;
 constructor(private readonly db:Db,private readonly upcoming:UpcomingService,private readonly provider:CatalogueProvider){this.repository=new RosterCatalogueRepository(db);}
 private async context(matchId:string){const schedule=await this.upcoming.schedule(),match=schedule.snapshot?.data.find(m=>m.providerMatchId===matchId);
  if(!match||match.opponents.length!==2||match.status!=='not_started'||match.scheduledAt!==null&&match.scheduledAt<=new Date().toISOString())throw new RosterCatalogueError('invalid');
  const rosters=await this.upcoming.tournament(match.tournament.providerTournamentId);return {match,rosters};
 }
 async state(owner:string,matchId:string){const {match,rosters}=await this.context(matchId);
  const teams=await Promise.all(match.opponents.map(async t=>{const players=rosters?.snapshot?.data.find(r=>r.providerTeamId===t.providerTeamId)?.players??[];
   const binding=await this.repository.latest(owner,t.providerTeamId);
   if(binding)binding.usable=binding.usable&&binding.players.every(p=>players.some(r=>r.providerPlayerId===p.providerPlayerId));
   return {...t,players,binding};}));
  return RosterCatalogueStateSchema.parse({matchId,rosterSha256:rosters?.snapshot?.source.payloadSha256??null,rosterFetchedAt:rosters?.snapshot?.source.fetchedAt??null,teams});
 }
 private async source(key:string):Promise<CatalogueObservation>{const cached=await this.repository.cached(key);
  if(cached?.fresh)return CatalogueObservationSchema.parse(cached.observation);
  const lease=await this.repository.claim(key);if(!lease){const ready=await this.repository.cached(key);if(ready?.fresh)return CatalogueObservationSchema.parse(ready.observation);throw new RosterCatalogueError('source_unavailable');}
  try{const observation=CatalogueObservationSchema.parse(await this.provider(key));
   // Validate raw hash and registry/account structure before caching or exposing candidates.
   if(key==='registry')catalogueCandidates(observation,'players','');
   await this.repository.publish(key,lease,observation);return observation;
  }catch{await this.repository.fail(key,lease);throw new RosterCatalogueError('source_unavailable');}
 }
 async search(matchId:string,kind:'teams'|'players',query:string){await this.context(matchId);const registry=await this.source('registry');
  return RosterCatalogueSearchResultSchema.parse({items:catalogueCandidates(registry,kind,query),source:'opendota',fetchedAt:registry.source.fetchedAt,payloadSha256:registry.source.payloadSha256});}
 async apply(owner:string,matchId:string,request:RosterCatalogueApply){
  const {match}=await this.context(matchId);if(!match.opponents.some(t=>t.providerTeamId===request.providerTeamId))throw new RosterCatalogueError('invalid');
  // Serialize preparation across processes without holding a pooled connection during HTTP.
  const lease=await this.repository.prepareLease(owner,request.providerTeamId);
  try{return await this.applySelected(owner,matchId,request,lease);}finally{await this.repository.releasePreparation(owner,request.providerTeamId,lease);}
 }
 private async applySelected(owner:string,matchId:string,request:RosterCatalogueApply,lease:string){
  const {match,rosters}=await this.context(matchId),team=rosters?.snapshot?.data.find(t=>t.providerTeamId===request.providerTeamId);
  if(!match.opponents.some(t=>t.providerTeamId===request.providerTeamId)||!team||!request.players.every(p=>team.players.some(r=>r.providerPlayerId===p.providerPlayerId)))throw new RosterCatalogueError('invalid');
  const replay=await this.repository.replay(owner,request);if(replay)return replay;
  if(rosters?.status!=='ready'||rosters.snapshot?.source.payloadSha256!==request.rosterSha256)throw new RosterCatalogueError('source_changed');
  if(await this.repository.revision(owner,request.providerTeamId)!==request.expectedRevision)throw new RosterCatalogueError('conflict');
  const registry=await this.source('registry');if(registry.source.payloadSha256!==request.registrySha256)throw new RosterCatalogueError('source_changed');
  // The team number must be explicitly selected from the same current registry.
  if(!catalogueCandidates(registry,'teams',request.teamId).some(t=>t.id===request.teamId))throw new RosterCatalogueError('invalid');
  const teamSource=await this.source('team:'+request.teamId);
  if(teamSource.source.endpoint!==`/teams/${request.teamId}`)throw new RosterCatalogueError('source_changed');
  let review;try{review=prepareRosterCatalogueSelection(registry,teamSource,request.players.map(p=>p.accountId),new Date().toISOString());}catch{throw new RosterCatalogueError('invalid');}
  const provisioner=new IdentityProvisioner(this.db),plan=await provisioner.preview(review);
  if(plan.status==='blocked')throw new RosterCatalogueError('conflict');
  let applied;try{applied=await provisioner.apply(review,plan.fingerprint);}catch(e){if(e instanceof IdentityProvisionError)throw new RosterCatalogueError('conflict');throw e;}
  const localTeam=(await sql<{id:string;name:string}>`SELECT id,name FROM teams WHERE opendota_team_id=${request.teamId}`.execute(this.db)).rows[0]!;
  await this.repository.checkPreparation(owner,request.providerTeamId,lease);
  const players=request.players.map(p=>{const row=applied.planAfter.rows.find(r=>r.accountId===p.accountId)!;
   return {...p,playerId:row.playerId!,name:row.alias,proMaps:0,identityStatus:'verified' as const};});
  // This owner association supports current role hints only, never historical identity evidence.
  const roleRepo=new RoleProfileRepository(this.db),old=await roleRepo.binding(owner,localTeam.id);
  const roleBinding={...old.binding,pandaTournamentId:match.tournament.providerTournamentId,pandaTeamId:request.providerTeamId,
   pandaPlayers:players.map(p=>({playerId:p.playerId,providerPlayerId:p.providerPlayerId}))};
  if(JSON.stringify(old.binding)!==JSON.stringify(roleBinding))await roleRepo.saveBinding(owner,localTeam.id,{requestId:randomUUID(),expectedRevision:old.revision,binding:roleBinding,confirmedByOwner:true});
  return this.repository.save(owner,request,{providerTeamId:request.providerTeamId,teamId:localTeam.id,teamName:localTeam.name,
   revision:request.expectedRevision+1,recordedAt:new Date().toISOString(),players,usable:true,
   source:{provider:'opendota',fetchedAt:registry.source.fetchedAt,payloadSha256:registry.source.payloadSha256,
    rosterFetchedAt:rosters.snapshot!.source.fetchedAt,rosterSha256:request.rosterSha256}});
 }
}
export const liveCatalogueProvider=(databaseUrl:string):CatalogueProvider=>async key=>{
 const runtime=createProviderRuntime({...process.env,DATABASE_URL:databaseUrl},3);
 try{return key==='registry'?await runtime.client.getProPlayers():await runtime.client.getTeam(key.slice(5));}finally{await runtime.close();}
};
