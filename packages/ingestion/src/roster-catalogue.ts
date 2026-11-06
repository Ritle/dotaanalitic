import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ReviewedCurrentCatalogueSchema,ReviewedCurrentAccountsSchema,Steam32Schema,type RosterCatalogueCandidate,type ProvisionBatch} from '@dota/contracts';
import {ProPlayersSchema,TeamSchema} from './opendota/schemas.js';
import {TeamDirectorySchema} from './opendota/team-directory.js';
import {prepareCurrentProfile} from './opendota/current-profile.js';
import {playerNameMatches} from './player-discovery.js';
export const CatalogueObservationSchema=z.object({rawBody:z.string().max(16*1024*1024),source:z.object({endpoint:z.string(),fetchedAt:z.iso.datetime({precision:3}),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/)})});
export type CatalogueObservation=z.infer<typeof CatalogueObservationSchema>;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function payload(input:unknown,endpoint:string){const o=CatalogueObservationSchema.parse(input);
 if(o.source.endpoint!==endpoint||sha(o.rawBody)!==o.source.payloadSha256||o.source.fetchedAt>new Date().toISOString())throw new Error('catalogue_source_binding');
 return {observation:o,raw:JSON.parse(o.rawBody) as unknown};
}
export function catalogueCandidates(input:unknown,kind:'teams'|'players',query:string):RosterCatalogueCandidate[]{
 const registry=ProPlayersSchema.parse(payload(input,'/proPlayers').raw),q=query.trim().toLowerCase();
 const personaMatches=new Set(registry.filter(p=>p.personaname&&playerNameMatches(p.personaname,query)).map(p=>p.account_id));
 const candidates: RosterCatalogueCandidate[]=kind==='players'?registry.filter(p=>p.steamid&&BigInt(p.steamid)===76561197960265728n+BigInt(p.account_id)).map(p=>({id:p.account_id,
 name:p.name??p.personaname??`ID ${p.account_id}`,teamId:p.team_id??null,teamName:p.team_name??null})): [...new Map(registry.filter(p=>p.team_id&&p.team_name).map(p=>[p.team_id!,{id:p.team_id!,name:p.team_name!,teamId:null,teamName:null}])).values()];
 return candidates.filter(p=>p.id===q||playerNameMatches(p.name,query)||kind==='players'&&personaMatches.has(p.id)).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).slice(0,25);
}
/** Parse only numeric identities on recognized hosts. The URL is never fetched. */
export function catalogueAccountQuery(query:string):string|null{
 let value=query.trim();
 if(!/^\d+$/.test(value)){
  let url:URL;try{url=new URL(value);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
  const steam=url.hostname==='steamcommunity.com',host=['stratz.com','www.stratz.com','opendota.com','www.opendota.com','dotabuff.com','www.dotabuff.com'].includes(url.hostname);
  const match=url.pathname.match(steam?/^\/profiles\/(\d+)\/?$/:/^\/players\/(\d+)\/?$/);if((!host&&!steam)||!match||steam&&match[1]!.length!==17)return null;value=match[1]!;
 }
 if(/^\d{17}$/.test(value)){const account=BigInt(value)-76561197960265728n;value=String(account);}
 const parsed=Steam32Schema.safeParse(value);return parsed.success?parsed.data:null;
}
function profileReview(input:unknown,id:string,reviewedAt:string){
 const {observation}=payload(input,`/players/${id}`);
 return prepareCurrentProfile({schemaVersion:1,mode:'current_profile_capture',accountId:id,
  observation:{...observation,source:{...observation.source,provider:'opendota',knownAt:null}}},sha(JSON.stringify(observation)),{accountIds:[id],reviewedAt}).review;
}
export function catalogueProfileCandidate(input:unknown,id:string):RosterCatalogueCandidate{
 const review=profileReview(input,id,new Date().toISOString()),account=review.accounts[0]!;
 return {id,name:account.alias,teamId:null,teamName:null,profileSha256:review.source.payloadSha256};
}
/** Validate all five before any write; each profile keeps its own original numeric proof. */
export function prepareRosterReviews(registryInput:unknown,teamInput:unknown|null,selected:{accountId:string;profileSha256?:string;localPlayerId?:string}[],profiles:unknown[],reviewedAt:string):ProvisionBatch[]{
 const registry=registryInput===null?null:payload(registryInput,'/proPlayers'),rows=registry?ProPlayersSchema.parse(registry.raw):[];
 if(teamInput){const o=CatalogueObservationSchema.parse(teamInput),t=TeamSchema.parse(JSON.parse(o.rawBody));if(o.source.fetchedAt>reviewedAt||!catalogueTeamCandidate(o,t.team_id))throw new Error('catalogue_team_missing');}
 if(selected.length!==5||new Set(selected.map(p=>p.accountId)).size!==5)throw new Error('catalogue_selection_invalid');
 const accounts=selected.filter(p=>!p.profileSha256&&!p.localPlayerId).map(({accountId})=>{const row=rows.find(p=>p.account_id===accountId);if(!row?.steamid)throw new Error('catalogue_account_missing');
  return {accountId,steam64:row.steamid,alias:(row.name?.trim()||row.personaname?.trim()||`ID ${accountId}`).slice(0,120)};});
 const reviews:ProvisionBatch[]=[];
 if(accounts.length){if(!registry)throw new Error('catalogue_registry_missing');const base={schemaVersion:1,policyVersion:'reviewed-current-accounts-v1',reviewedAt,accounts,
  source:{reportSha256:sha(JSON.stringify({registry:registry.observation,selected})),payloadSha256:registry.observation.source.payloadSha256,url:'https://api.opendota.com/api/proPlayers',knownAt:registry.observation.source.fetchedAt,fetchedAt:registry.observation.source.fetchedAt}};
  if(teamInput){const observation=CatalogueObservationSchema.parse(teamInput),t=TeamSchema.parse(JSON.parse(observation.rawBody));payload(observation,`/teams/${t.team_id}`);
   reviews.push(ReviewedCurrentCatalogueSchema.parse({...base,policyVersion:'reviewed-current-catalogue-v1',teams:[{teamId:t.team_id,name:t.name,tag:t.tag??null,source:observation.source}]}));
  }else reviews.push(ReviewedCurrentAccountsSchema.parse(base));
 }
 for(const p of selected.filter(p=>p.profileSha256&&!p.localPlayerId)){const observation=profiles.find(o=>CatalogueObservationSchema.parse(o).source.endpoint===`/players/${p.accountId}`);
  const review=profileReview(observation,p.accountId,reviewedAt);if(review.source.payloadSha256!==p.profileSha256)throw new Error('catalogue_source_binding');reviews.push(review);
 }
 return reviews;
}
export function catalogueDirectoryCandidates(input:unknown,query:string):RosterCatalogueCandidate[]{
 const rows=TeamDirectorySchema.parse(payload(input,'/teams').raw),q=query.trim().toLowerCase();
 return rows.filter(p=>p.name?.trim()&&(p.team_id===q||p.name.toLowerCase().includes(q)||p.tag?.toLowerCase().includes(q)))
  .sort((a,b)=>Number(b.team_id===q)-Number(a.team_id===q)||(a.name??'').localeCompare(b.name??''))
  .slice(0,25).map(p=>({id:p.team_id,name:p.name!,teamId:null,teamName:null}));
}
export function catalogueTeamCandidate(input:unknown,id:string):RosterCatalogueCandidate|null{
 const t=TeamSchema.parse(payload(input,`/teams/${id}`).raw);if(t.team_id!==id)throw new Error('catalogue_source_binding');
 return t.name?.trim()?{id:t.team_id,name:t.name,teamId:null,teamName:null}:null;
}
/** Organization metadata is optional for verified, explicitly selected player accounts. */
export function prepareRosterAccounts(registryInput:unknown,accountIds:string[],reviewedAt:string){
 const registry=payload(registryInput,'/proPlayers'),rows=ProPlayersSchema.parse(registry.raw);
 if(accountIds.length!==5||new Set(accountIds).size!==5)throw new Error('catalogue_selection_invalid');
 const accounts=accountIds.map(id=>{const p=rows.find(r=>r.account_id===id);if(!p?.steamid)throw new Error('catalogue_account_missing');return {accountId:id,steam64:p.steamid,alias:(p.name?.trim()||p.personaname?.trim()||`ID ${id}`).slice(0,120)};});
 return ReviewedCurrentAccountsSchema.parse({schemaVersion:1,policyVersion:'reviewed-current-accounts-v1',reviewedAt,
  source:{reportSha256:sha(JSON.stringify({registry:registry.observation,accountIds})),payloadSha256:registry.observation.source.payloadSha256,url:'https://api.opendota.com/api/proPlayers',
   knownAt:registry.observation.source.fetchedAt,fetchedAt:registry.observation.source.fetchedAt},accounts});
}
/** Explicit owner selection; nicknames are labels, never an identity join. */
export function prepareRosterCatalogueSelection(registryInput:unknown,teamInput:unknown,accountIds:string[],reviewedAt:string){
 const registry=payload(registryInput,'/proPlayers'),teamObservation=CatalogueObservationSchema.parse(teamInput);
 const t=TeamSchema.parse(JSON.parse(teamObservation.rawBody));payload(teamObservation,`/teams/${t.team_id}`);
 const rows=ProPlayersSchema.parse(registry.raw);
 if(accountIds.length!==5||new Set(accountIds).size!==5||!t.name?.trim())throw new Error('catalogue_selection_invalid');
 const accounts=accountIds.map(id=>{const p=rows.find(r=>r.account_id===id);if(!p?.steamid)throw new Error('catalogue_account_missing');
  return {accountId:id,steam64:p.steamid,alias:(p.name??p.personaname??`ID ${id}`).slice(0,120)};});
 return ReviewedCurrentCatalogueSchema.parse({schemaVersion:1,policyVersion:'reviewed-current-catalogue-v1',reviewedAt,
  source:{reportSha256:sha(JSON.stringify({registry:registry.observation,team:teamObservation,accountIds})),payloadSha256:registry.observation.source.payloadSha256,
   url:'https://api.opendota.com/api/proPlayers',knownAt:registry.observation.source.fetchedAt,fetchedAt:registry.observation.source.fetchedAt},accounts,
  teams:[{teamId:t.team_id,name:t.name,tag:t.tag??null,source:teamObservation.source}]});
}
