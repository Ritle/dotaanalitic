import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Steam32Schema,type RosterCatalogueCandidate} from '@dota/contracts';
import {CatalogueObservationSchema} from './roster-catalogue.js';
export const discoveryQuery=(query:string)=>query.trim().normalize('NFKC').toLowerCase();
export const discoveryKey=(query:string)=>'search:'+createHash('sha256').update(discoveryQuery(query)).digest('hex');
export const discoveryEndpoint=(query:string)=>'/search?q='+encodeURIComponent(discoveryQuery(query));
/** History is a review hint, never identity evidence. Preserve every candidate and stable ties. */
export function rankPlayerCandidatesByHistory(candidates:readonly RosterCatalogueCandidate[],query:string):RosterCatalogueCandidate[]{
 const q=discoveryQuery(query),exact=(p:RosterCatalogueCandidate)=>[p.name,...p.aliases??[]].some(n=>discoveryQuery(n)===q);
 return candidates.map((candidate,index)=>({candidate,index})).sort((a,b)=>Number(exact(b.candidate))-Number(exact(a.candidate))||
  Number((b.candidate.proMaps??0)>0)-Number((a.candidate.proMaps??0)>0)||a.index-b.index).map(r=>r.candidate);
}
/** Rank suggestions only. Equal names never establish a provider-player/account identity. */
export function preferExactPlayerCandidates(candidates:readonly RosterCatalogueCandidate[],query:string):RosterCatalogueCandidate[]{
 const q=discoveryQuery(query),named=candidates.filter(p=>[p.name,...p.aliases??[]].some(name=>playerNameMatches(name,query))),exact=named.filter(p=>[p.name,...p.aliases??[]].some(name=>discoveryQuery(name)===q));
 return exact.length?exact:named;
}
export const PlayerSearchRowsSchema=z.array(z.object({account_id:z.preprocess(v=>typeof v==='number'&&Number.isSafeInteger(v)?String(v):v,Steam32Schema),personaname:z.string().max(256).nullable()})).max(1000);
/** Name matching is discovery only; it never establishes identity or attendance. */
export function playerNameMatches(name:string,query:string){
 const q=discoveryQuery(query),n=discoveryQuery(name),compact=(s:string)=>s.replace(/[^\p{L}\p{N}]/gu,'');
 if(n.includes(q)||compact(q).length>=3&&compact(n).includes(compact(q)))return true;
 const words=(s:string)=>s.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=3||/^\d+$/.test(w));
 const a=new Set(words(name)),b=new Set(words(query));
 const shared=[...a].filter(w=>b.has(w)).length;return shared>=2&&shared===Math.min(a.size,b.size);
}
export function discoveryCandidates(input:unknown,query:string):RosterCatalogueCandidate[]{
 const o=CatalogueObservationSchema.parse(input);
 if(o.source.endpoint!==discoveryEndpoint(query)||o.source.fetchedAt>new Date().toISOString()||createHash('sha256').update(o.rawBody).digest('hex')!==o.source.payloadSha256)throw Error('search_source_binding');
 const rows=PlayerSearchRowsSchema.parse(JSON.parse(o.rawBody));
 return [...new Map(rows.filter(p=>p.personaname?.trim()).map(p=>[p.account_id,{id:p.account_id,name:p.personaname!,teamId:null,teamName:null,discovery:true,observedAt:o.source.fetchedAt,
  reason:'Поиск OpenDota по нику; числовой профиль нужно проверить перед выбором'}])).values()].slice(0,25);
}
