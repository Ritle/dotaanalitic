import {RosterCatalogueRepository,type Db} from '@dota/db';
import {RosterContextSchema,type RosterContext} from './roster-context-contract.js';
import {RosterContextRepository} from './roster-context-repository.js';
import {readRosterRegistry} from './roster-context-source.js';

export class RosterContextService{
 constructor(private readonly db:Db,private readonly refreshRegistry:()=>Promise<unknown>){}
 async read(kind:'teams'|'players',id:string,refresh=false):Promise<RosterContext|null>{
  const repo=new RosterContextRepository(this.db),entity=await repo.entity(kind,id);if(!entity)return null;
  const identity=kind==='players'?await repo.playerIdentity(id):null;
  const canRefresh=kind==='teams'?!!entity.providerId:identity?.identityStatus==='verified';let refreshFailed=false;
  if(refresh&&canRefresh)try{
   const cached=await new RosterCatalogueRepository(this.db).cached('registry');
   if(cached?.observation){let valid=false;try{const registry=readRosterRegistry(cached.observation,new Date().toISOString());valid=Date.now()-Date.parse(registry.source.fetchedAt)<3600000;}catch{/* Refetch only on explicit POST. */}
    if(!valid)await repo.expireRegistry(cached.observation);}
   await this.refreshRegistry();
  }catch{refreshFailed=true;}
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
   const repository=new RosterContextRepository(tx),current=await repository.entity(kind,id);if(!current)return null;
   const player=kind==='players'?await repository.playerIdentity(id):null,now=new Date().toISOString();
   const cached=await new RosterCatalogueRepository(tx).cached('registry');let registry:ReturnType<typeof readRosterRegistry>|null=null;
   if(cached?.observation)try{registry=readRosterRegistry(cached.observation,now);}catch{/* Invalid cache must not supply current membership. */}
   const eligible=kind==='teams'?!!current.providerId:player?.identityStatus==='verified';
   const result:RosterContext={schemaVersion:1,kind,entityId:id,computedAt:now,canRefresh:eligible,
    status:!eligible?(kind==='teams'?'team_unlinked':'identity_unresolved'):!registry?'source_missing':'not_listed',
    source:{provider:'opendota',endpoint:'/proPlayers',status:registry?(cached!.fresh&&Date.parse(now)-Date.parse(registry.source.fetchedAt)<3600000?'ready':'stale'):cached?.observation?'unavailable':'not_loaded',
     fetchedAt:registry?.source.fetchedAt??null,payloadSha256:registry?.source.payloadSha256??null,eventAt:null,knownAt:null,refreshFailed:refreshFailed||refresh&&!registry&&eligible},
    identityStatus:player?.identityStatus??null,accountId:player?.identityStatus==='verified'?player.accountIds[0]!:null,team:null,members:[]};
   if(!eligible||!registry)return RosterContextSchema.parse(result);
   const rows=registry.players.filter(p=>kind==='teams'?p.team_id===current.providerId:p.account_id===player!.accountIds[0]);
   const links=await repository.members(rows.map(p=>p.account_id),now);
   const providerIds=[...new Set(rows.flatMap(p=>p.team_id?[p.team_id]:[]))];const teams=await repository.teams(providerIds);
   const team=(providerTeamId:string|null|undefined,name:string|null|undefined)=>providerTeamId?{
    id:teams.find(t=>t.providerId===providerTeamId)?.id??null,providerTeamId,name:name?.trim()||teams.find(t=>t.providerId===providerTeamId)?.name||null}:null;
   result.members=rows.map(p=>({...links.find(l=>l.accountId===p.account_id)!,name:p.name?.trim()||p.personaname?.trim()||'Имя не указано',
    team:team(p.team_id,p.team_name)})).sort((a,b)=>a.name.localeCompare(b.name)||a.accountId.localeCompare(b.accountId));
   result.team=kind==='teams'?{id:current.id,providerTeamId:current.providerId!,name:current.name}:result.members[0]?.team??null;
   result.status=kind==='teams'?(rows.length?'listed':'not_listed'):(result.team?'listed':'not_listed');
   return RosterContextSchema.parse(result);
  });
 }
}
