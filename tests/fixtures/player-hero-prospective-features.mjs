// Synthetic evidence only; never use as provider data or a production model input.
import {fixture,rebind,T,day} from './player-hero-prospective-input.mjs';
import {createProspectiveCapture,captureDigest} from '../../.tools/s304-prospective-capture-runtime/player-hero-prospective-capture.mjs';
export function bindFeatureEvidence(f){
  for(const o of f.outcomeObservations){const m=f.history.maps.find(m=>m.matchId===o.matchId);
    if(m){o.factSha256=captureDigest(m);o.sourceSha256=m.payloadSha256;o.fetchedAtUs=m.fetchedAtUs;}}
  for(const o of f.identityObservations){const i=f.history.identities.find(i=>i.observationId===o.observationId);
    if(i){o.factSha256=captureDigest(i);o.fetchedAtUs=String(BigInt(Date.parse(i.fetchedAt))*1000n);
      o.sourceKnownAtUs=i.knownAt===null?null:String(BigInt(Date.parse(i.knownAt))*1000n);}}
  return f;
}
export function featureFixture(){
  const raw=fixture();raw.history.maps[0].players[0].heroId=20;rebind(raw);
  const capture=createProspectiveCapture(raw),iso=t=>new Date(Number(t/1000n)).toISOString();
  const strip=players=>players.map(({playerId,accountId})=>({playerId,accountId}));
  const identities=[...raw.scenario.teamA,...raw.scenario.teamB].map(p=>({observationId:p.playerId,
    playerId:p.playerId,externalAccountId:p.accountId,provider:'opendota',status:'verified',
    eventAt:null,knownAt:null,fetchedAt:iso(T-10n*day),source:'synthetic',evidenceRef:'synthetic-account:'+p.accountId}));
  const history={schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:captureDigest(raw.history),
    identityRevision:'1',snapshotAtUs:raw.history.snapshotAtUs,warmupFromAtUs:raw.history.fromAtUs,syntheticOnly:true,identities,
    maps:raw.history.maps.map((m,i)=>({matchId:m.matchId,seriesKey:'synthetic-series:'+i,startedAtUs:m.startedAtUs,
      completedAtUs:m.completedAtUs,isPro:true,teamA:strip(m.players.slice(0,5)),teamB:strip(m.players.slice(5)),
      teamAWon:i!==2,outcomeReceiptId:String(i+1),payloadSha256:m.receiptSha256,fetchedAtUs:m.fetchedAtUs,
      labelVerifiedAtUs:String(BigInt(m.fetchedAtUs)+1n),factClocks:[]}))};
  const obs=at=>({sourceSha256:'b'.repeat(64),factSha256:'b'.repeat(64),sourceKnownAtUs:null,
    fetchedAtUs:String(at),observedAtUs:String(at+10n),recordedAtUs:String(at+20n)});
  return bindFeatureEvidence({format:'player-hero-prospective-features-input-v1',capture,history,
    outcomeObservations:history.maps.map(m=>({...obs(BigInt(m.fetchedAtUs)),matchId:m.matchId,basis:'verified_professional_map_outcome'})),
    identityObservations:identities.map(i=>({...obs(T-10n*day),observationId:i.observationId}))});
}
