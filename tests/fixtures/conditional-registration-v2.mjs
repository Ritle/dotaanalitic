import {readFile} from 'node:fs/promises';
import {realRegistrationFixture} from './conditional-real-registration.mjs';
import {realSha} from '../../tools/research/conditional-real-registration.mjs';
import {registrationV2ManifestPaths} from '../../tools/research/conditional-real-registration-v2.mjs';
/** Synthetic documents ONLY for disposable database tests; never real evidence.
 * syntheticOnly:false emulates the untrusted claim that production receives; source authenticity is owner-reviewed. */
export async function registrationV2Fixture(owner='11111111-1111-4111-8111-111111111111'){
 const p=await realRegistrationFixture(owner),policy=JSON.parse(p.policyText),sources=[],bindings=[];
 const add=(id,url,bodyText)=>{sources.push({id,url,bodyText,sha256:realSha(bodyText),fetchedAt:'2026-11-15T00:00:00.000Z',
  knownAt:null,httpStatus:200,representation:'retained_http_utf8'});return id;};
 const native=add('catalogue','https://api.opendota.com/api/leagues',JSON.stringify(policy.proposedRegistration.events.map((e,i)=>({leagueid:String(90001+i),name:e.name,tier:'professional'}))));
 for(const [i,e] of policy.proposedRegistration.events.entries()){
  const leagueId=String(90001+i),period=e.fromDate+' through '+e.throughDate,href='https://www.opendota.com/leagues/'+leagueId;
  const section=e.name+' 2026 <a href="'+href+'">League</a>';
  bindings.push({editionKey:e.name,leagueId,native:{sourceId:native},
   calendar:{sourceId:add('calendar'+i,e.source,'SYNTHETIC TEST ONLY '+e.name+' '+period),editionExcerpt:e.name,periodExcerpt:period,
    fromDate:e.fromDate,throughDate:e.throughDate,reviewNote:'Synthetic calendar excerpt reviewed for test only',
    startBound:{at:e.fromDate+'T00:00:00.000Z',basis:'owner_reviewed_lower_bound',explanation:'Synthetic lower bound used only in isolated tests'}},
   link:{sourceId:add('link'+i,new URL('/synthetic-event/'+i,e.source).href,'SYNTHETIC TEST ONLY '+section),section,href,
    reviewNote:'Synthetic explicit organizer link reviewed for test only'}});
 }
 p.format='conditional-real-registration-package-v2';p.review={format:'conditional-tournament-binding-review-v2',policySha256:realSha(p.policyText),
  syntheticOnly:false,reviewedAt:'2026-11-15T00:30:00.000Z',reviewerUserId:owner,sources,bindings};
 p.collection.enrollment='reviewed-native-event-register-v2';
 for(const path of await registrationV2ManifestPaths())p.executable.code[path]=realSha(await readFile(path));
 return p;
}
