import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ReviewedCurrentCatalogueSchema,type RosterCatalogueCandidate} from '@dota/contracts';
import {ProPlayersSchema,TeamSchema} from './opendota/schemas.js';
export const CatalogueObservationSchema=z.object({rawBody:z.string().max(16*1024*1024),source:z.object({endpoint:z.string(),fetchedAt:z.iso.datetime({precision:3}),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/)})});
export type CatalogueObservation=z.infer<typeof CatalogueObservationSchema>;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function payload(input:unknown,endpoint:string){const o=CatalogueObservationSchema.parse(input);
 if(o.source.endpoint!==endpoint||sha(o.rawBody)!==o.source.payloadSha256||o.source.fetchedAt>new Date().toISOString())throw new Error('catalogue_source_binding');
 return {observation:o,raw:JSON.parse(o.rawBody) as unknown};
}
export function catalogueCandidates(input:unknown,kind:'teams'|'players',query:string):RosterCatalogueCandidate[]{
 const registry=ProPlayersSchema.parse(payload(input,'/proPlayers').raw),q=query.trim().toLowerCase();
 const candidates: RosterCatalogueCandidate[]=kind==='players'?registry.filter(p=>p.steamid&&BigInt(p.steamid)===76561197960265728n+BigInt(p.account_id)).map(p=>({id:p.account_id,
 name:p.name??p.personaname??`ID ${p.account_id}`,teamId:p.team_id??null,teamName:p.team_name??null})): [...new Map(registry.filter(p=>p.team_id&&p.team_name).map(p=>[p.team_id!,{id:p.team_id!,name:p.team_name!,teamId:null,teamName:null}])).values()];
 return candidates.filter(p=>p.id===q||p.name.toLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).slice(0,25);
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
