import type {RosterCatalogueCandidate} from '@dota/contracts';
import {discoveryQuery} from '@dota/ingestion';

/** Conservative automatic discovery only. A name never verifies an account or attendance. */
export function rosterNameCandidates(candidates:readonly RosterCatalogueCandidate[],query:string):RosterCatalogueCandidate[]{
 const q=discoveryQuery(query);if(!q)return [];
 const names=(p:RosterCatalogueCandidate)=>[p.name,...p.aliases??[]].map(discoveryQuery);
 const exact=candidates.filter(p=>names(p).includes(q));if(exact.length)return exact;
 if(!/[\p{L}\p{N}]/u.test(q))return [];
 const compact=(s:string)=>s.replace(/[^\p{L}\p{N}]/gu,'');
 const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const token=new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`,'u');
 return candidates.filter(p=>names(p).some(n=>token.test(n)||compact(q).length>=3&&compact(n)===compact(q)));
}
