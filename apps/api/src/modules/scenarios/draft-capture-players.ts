import type {ScenarioInput} from '@dota/contracts';
import type {DraftCaptureIdentity,DraftCaptureSnapshot} from './draft-capture-contract.js';
import {resolveIdentity} from '@dota/db';

/** Canonical player and role are taken from the saved revision. No nickname matching or side inference. */
export function captureDraftPlayers(input:ScenarioInput,evidence:DraftCaptureIdentity[]):DraftCaptureSnapshot['players']{
  return (['A','B'] as const).flatMap(teamSlot=>(teamSlot==='A'?input.lineupA:input.lineupB).map(p=>{
    const ids=[...new Set(evidence.filter(e=>e.playerId===p.playerId&&e.status==='verified').map(e=>e.externalAccountId))];
    const valid=ids.filter(id=>resolveIdentity(evidence,id,null).playerId===p.playerId);
    const ambiguous=ids.length>1||ids.some(id=>resolveIdentity(evidence,id,null).status==='conflict');
    const accountId=!ambiguous&&valid.length===1?valid[0]!:null;
    return {teamSlot,rolePos:p.rolePos,playerId:p.playerId!,
      heroId:input.draft?.assignments.find(a=>a.teamSlot===teamSlot&&a.rolePos===p.rolePos)?.heroId??null,
      accountId,identityStatus:ambiguous?'ambiguous' as const:accountId?'verified' as const:'missing' as const,
      observationIds:evidence.filter(e=>ids.includes(e.externalAccountId)).map(e=>e.observationId).sort()};
  })).sort((a,b)=>a.teamSlot.localeCompare(b.teamSlot)||a.rolePos-b.rolePos);
}
