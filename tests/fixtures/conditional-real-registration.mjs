import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {requiredRealRegistrationCode} from '../../tools/research/conditional-real-registration.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
/** Synthetic source/review documents. Never use this fixture as real registration evidence. */
export async function realRegistrationFixture(ownerUserId='11111111-1111-4111-8111-111111111111'){
 const policyText=await readFile('tools/research/player-hero-conditional-future-policy.json','utf8'),policy=JSON.parse(policyText);
 const candidateText=await readFile(policy.candidate.artifactPath,'utf8'),ledger=JSON.parse(await readFile(policy.independence.exposure.path,'utf8')).result.ledger;
 const exposureText=JSON.stringify({mapIds:ledger.mapIds,canonicalSeriesKeys:ledger.canonicalSeriesKeys});
 const observedAt='2026-11-15T00:00:00.000Z';
 const bindings=policy.proposedRegistration.events.map((event,i)=>{
  const leagueId=String(90001+i),bodyText=JSON.stringify({syntheticFixture:true,event:{nativeLeagueId:leagueId,organizerReference:event.source}});
  const calendarText='SYNTHETIC TEST DOCUMENT: '+event.name+' '+event.fromDate+' '+event.throughDate;
  return {editionKey:event.name,leagueId,stage:'main_event',
   startBound:{at:event.fromDate+'T00:00:00.000Z',basis:'owner_reviewed_lower_bound',explanation:'Synthetic fixture lower bound, not real gameplay evidence'},
   calendar:{url:event.source,observedAt,bodyText:calendarText,sha256:sha(calendarText)},
   nativeReference:{url:'https://api.stratz.com/fixture',observedAt,bodyText,sha256:sha(bodyText),
    nativeIdPointer:'/event/nativeLeagueId',organizerUrlPointer:'/event/organizerReference'},
   reviewNote:'Synthetic numeric source reference and main-event scope reviewed for test only'};
 });
 const code={};for(const path of requiredRealRegistrationCode)code[path]=sha(await readFile(path));
 // Runtime environment is populated by the integration harness from the actual local inspector.
 const environmentText=JSON.stringify({syntheticFixture:true});
 return {format:'conditional-real-registration-package-v1',policyText,candidateText,exposureText,exposureBaseText:exposureText,exposureParentSha256:policy.independence.exposure.sha256,
  review:{ownerUserId,reviewedAt:'2026-11-15T00:30:00.000Z',reason:'Synthetic fixture for the registration adapter only',bindings},
  executable:{capturedAt:observedAt,code,environmentText,environmentSha256:sha(environmentText)},
  collection:{discovery:'registered_league_and_global_cursor_reconciliation',enrollment:'reviewed-native-event-register-v1',
   maxTargetMaps:policy.budget.maxTargetMaps,maxHttpAttempts:policy.budget.maxHttpAttemptsIncludingRetries,
   maxDailyAttempts:policy.budget.maxHttpAttemptsPerUtcDay,maxConcurrentRequests:1,
   assessmentMode:'one_terminal_assessment_after_window_and_grace'}};
}
