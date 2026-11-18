// Synthetic provider-shaped records, never live evidence.
import {bundleFixture,T,day} from './conditional-future-holdout.mjs';
import {inspectConditionalSources,sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
import {conditionalDigest} from '../../.tools/s304-future-runtime/conditional-future-holdout.mjs';
const iso=us=>new Date(Number(us/1000n)).toISOString();
export function bindFixture(f){
 for(const r of f.archive.receipts){r.bodySha256=sourceSha(r.rawBody);if(r.kind==='raw_http')r.originalPayloadSha256=r.bodySha256;}
 f.archive.leagues.bodySha256=sourceSha(f.archive.leagues.rawBody);
 const {rows}=inspectConditionalSources(f.archive),sources=new Map(rows.map(r=>[r.matchId,r]));
 const fingerprint=conditionalDigest(f.archive),snapshot=String(BigInt(Date.parse(f.archive.recordedAt))*1000n);
 for(const c of f.input.cases){
  const t=sources.get(c.target.matchId);if(t?.target)c.target=structuredClone(t.target);
  for(const name of ['history','heroHistory']){
   const h=c[name];h.snapshotAtUs=snapshot;
   if(name==='history'){h.sourceFingerprint=fingerprint;h.identities=structuredClone(f.archive.identities);}else h.sourceSha256=fingerprint;
   h.maps=h.maps.map(m=>structuredClone(sources.get(m.matchId)?.[name]??m));
  }
 }
 return f;
}
export function sourceFixture(){
 const input=bundleFixture(),maps=new Map();
 for(const c of input.cases){
  for(const m of c.history.maps){const h=c.heroHistory.maps.find(h=>h.matchId===m.matchId);
   maps.set(m.matchId,{match_id:m.matchId,series_id:JSON.parse(m.seriesKey)[1],leagueid:'300',
    start_time:Number(BigInt(m.startedAtUs)/1000000n),duration:Number((BigInt(m.completedAtUs)-BigInt(m.startedAtUs))/1000000n),
    radiant_team_id:'100',dire_team_id:'200',radiant_win:m.teamAWon,
    players:[...m.teamA,...m.teamB].map((p,i)=>({player_slot:i<5?i:128+i-5,account_id:p.accountId,hero_id:h.players.find(h=>h.accountId===p.accountId).heroId}))});
  }
  maps.set(c.target.matchId,{match_id:c.target.matchId,series_id:'99',leagueid:'300',start_time:Number(BigInt(c.target.startedAtUs)/1000000n),duration:3600,
   radiant_team_id:'100',dire_team_id:'200',radiant_win:true,players:c.target.players.map(p=>({player_slot:p.slot,account_id:p.accountId,hero_id:p.heroId}))});
 }
 const archive={format:'conditional-source-archive-v1',syntheticOnly:true,recordedAt:iso(T+3n*day),
  targetMapIds:input.cases.map(c=>c.target.matchId),historyMapIds:input.cases[0].history.maps.map(m=>m.matchId),
  provenance:{kind:'synthetic_fixture',sourceSha256:'a'.repeat(64)},identities:structuredClone(input.cases[0].history.identities),
  teams:[{nativeId:'100',canonicalId:'10'},{nativeId:'200',canonicalId:'20'}],
  leagues:{rawBody:JSON.stringify([{leagueid:300,tier:'professional',name:'Synthetic event'}]),bodySha256:'a'.repeat(64),fetchedAt:iso(T+2n*day)},
  receipts:[...maps].map(([id,p],i)=>({matchId:id,receiptId:String(i+1),kind:'raw_http',originalPayloadSha256:'a'.repeat(64),
   rawBody:JSON.stringify(p),bodySha256:'a'.repeat(64),fetchedAt:iso(T+2n*day),adapterVersion:'synthetic-local-v1',endpoint:'/matches/'+id}))};
 return bindFixture({input,archive});
}
