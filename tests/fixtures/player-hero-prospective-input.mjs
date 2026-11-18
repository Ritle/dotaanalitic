// Synthetic only. These asserted receipts/clocks are not real match evidence.
import {captureDigest,selectionDigest,identityDigest,historyFactDigest} from '../../.tools/s304-prospective-capture-runtime/player-hero-prospective-capture.mjs';
export const day=86400000000n,T=1800000000000000n;
const source='a'.repeat(64);
export function rebind(input){
  for(const kind of ['lineup','draft'])if(input[kind+'Observation'])input[kind+'Observation'].factSha256=selectionDigest(input,kind);
  for(const o of input.identityObservations)o.factSha256=identityDigest(o.playerId,o.accountId);
  for(const o of input.historyObservations){const m=input.history.maps.find(m=>m.matchId===o.matchId);
    if(m){o.factSha256=historyFactDigest(m);o.sourceSha256=m.receiptSha256;o.sourceKnownAtUs=m.knownAtUs;}}
  return input;
}
export function fixture(){
  const players=Array.from({length:10},(_,i)=>({playerId:String(i+1),accountId:String(i+101),heroId:i+1}));
  const maps=Array.from({length:5},(_,i)=>{
    const start=T-BigInt(i+1)*day,end=start+day/2n,matchId=String(9007199254740993n+BigInt(i));
    return {matchId,startedAtUs:String(start),completedAtUs:String(end),fetchedAtUs:String(end+1000n),knownAtUs:String(end+500n),
      isPro:true,receiptSha256:captureDigest({syntheticReceiptFor:matchId}),canonicalPatchId:null,players:structuredClone(players)};
  });
  const observation=(at)=>({sourceSha256:source,factSha256:source,sourceKnownAtUs:null,
    fetchedAtUs:String(at-1n),observedAtUs:String(at),recordedAtUs:String(at+1n)});
  return rebind({format:'player-hero-prospective-input-v1',syntheticOnly:true,decisionCutoffAtUs:String(T),
    snapshotFrozenAtUs:String(T+3000000n),scenarioRevision:'1',
    scenario:{targetMatchId:'9007199254741099',cutoffAtUs:String(T),teamA:players.slice(0,5),teamB:players.slice(5),
      canonicalPatchId:null,heroBasis:'owner_selected',selectedAtUs:String(T-5000000n),sourceSha256:source},
    history:{format:'verified-player-hero-history-v1',syntheticOnly:true,sourceSha256:source,fromAtUs:String(T-200n*day),
      toAtUs:String(T+1000000n),snapshotAtUs:String(T+2000000n),maps},
    lineupObservation:{...observation(T-4000000n),basis:'owner_asserted_asof'},
    draftObservation:{...observation(T-3000000n),basis:'owner_asserted_asof'},
    identityObservations:players.map(p=>({...observation(T-10n*day),basis:'verified_account_link',playerId:p.playerId,accountId:p.accountId})),
    historyObservations:maps.map(m=>({...observation(BigInt(m.fetchedAtUs)+10n),basis:'provider_known_at',matchId:m.matchId})),
  });
}
