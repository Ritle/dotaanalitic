// Synthetic local inputs, not provider receipts or registered independent targets.
export const day=86400000000n,T=1800000000000000n,sha='a'.repeat(64);
export const series=id=>JSON.stringify(['opendota',id]);
export function featureFixture(){
 const players=Array.from({length:10},(_,i)=>({playerId:String(i+1),accountId:String(i+101),heroId:i+1}));
 const strip=ps=>ps.map(({playerId,accountId})=>({playerId,accountId}));
 const maps=Array.from({length:6},(_,i)=>({matchId:String(9007199254740993n+BigInt(i)),seriesKey:series(String(i+1)),
  startedAtUs:String(T-BigInt(i+1)*day),completedAtUs:String(T-BigInt(i+1)*day+day/2n),isPro:true,
  teamA:strip(players.slice(0,5)),teamB:strip(players.slice(5)),teamAWon:i!==2,
  outcomeReceiptId:String(i+1),payloadSha256:sha,fetchedAtUs:String(T+day),labelVerifiedAtUs:String(T+day),factClocks:[]}));
 return {format:'conditional-future-feature-input-v1',target:{matchId:'9007199254741099',seriesKey:series('99'),eventId:'300',
   startedAtUs:String(T),isPro:true,radiantTeamId:'10',direTeamId:'20',canonicalPatchId:null,
   sourceSha256:sha,knownAtUs:null,fetchedAtUs:String(T+day),
   players:players.map((p,i)=>({...p,slot:i<5?i:128+i-5}))},
  history:{schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:sha,identityRevision:'1',
   snapshotAtUs:String(T+2n*day),warmupFromAtUs:String(T-200n*day),syntheticOnly:true,maps,
   identities:players.map(p=>({observationId:p.playerId,playerId:p.playerId,externalAccountId:p.accountId,provider:'opendota',
    status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date(Number((T+day)/1000n)).toISOString(),source:'synthetic',evidenceRef:'synthetic:'+p.accountId}))},
  heroHistory:{format:'verified-player-hero-history-v1',syntheticOnly:true,sourceSha256:sha,fromAtUs:String(T-200n*day),
   toAtUs:String(T+day),snapshotAtUs:String(T+2n*day),maps:maps.map((m,i)=>({matchId:m.matchId,startedAtUs:m.startedAtUs,
    completedAtUs:m.completedAtUs,isPro:true,fetchedAtUs:m.fetchedAtUs,knownAtUs:null,receiptSha256:sha,canonicalPatchId:null,
    players:players.map((p,j)=>({...p,heroId:i===0&&j===0?20:p.heroId}))}))}};
}
export function bundleFixture(){
 const a=featureFixture(),b=featureFixture();b.target.matchId='9007199254741100';b.target.startedAtUs=String(T+day);
 return {format:'conditional-future-holdout-input-v1',syntheticOnly:true,
  window:{fromAtUs:String(T-day),untilAtUs:String(T+4n*day)},eventIds:['300'],inventoryComplete:true,inventorySourceSha256:sha,
  exposure:{sourceSha256:sha,mapIds:[],seriesKeys:[]},
  series:[{seriesKey:series('99'),eventId:'300',complete:true,mapIds:[a.target.matchId,b.target.matchId],completedAtUs:String(T+2n*day),sourceSha256:sha}],
  cases:[{target:a.target,history:a.history,heroHistory:a.heroHistory},{target:b.target,history:b.history,heroHistory:b.heroHistory}]};
}
