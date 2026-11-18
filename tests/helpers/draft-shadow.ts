import {observationFeatureFixture,editObservation} from './draft-observation-features.js';
export function shadowFeatureFixture(){
  const f=observationFeatureFixture();
  editObservation(f,e=>{
    const original=structuredClone(e.history),outcomes=structuredClone(e.outcomes);
    for(const p of original.identities)e.history.identities.push({...p,observationId:p.observationId+':opponent',
      playerId:String(BigInt(p.playerId)+1000n),externalAccountId:String(BigInt(p.externalAccountId!)+1000n)});
    // Six games for each selected five against different opponents: no target encounter.
    for(const p of e.history.players)if(p.side==='dire'){
      p.player_id=String(BigInt(p.player_id!)+1000n);p.source_account_id=String(BigInt(p.source_account_id!)+1000n);
    }
    for(const m of original.maps){
      const id=String(BigInt(m.id)+1000n);e.history.maps.push({...m,id});
      const r=original.receipts.find(r=>r.canonical_match_id===m.id)!;
      e.history.receipts.push({...r,id:String(BigInt(r.id)+1000n),canonical_match_id:id,provider_match_id:id});
      for(const p of original.players.filter(p=>p.match_id===m.id))e.history.players.push({...p,match_id:id,
        player_id:p.side==='radiant'?String(BigInt(p.player_id!)+1000n):p.player_id,
        source_account_id:p.side==='radiant'?String(BigInt(p.source_account_id!)+1000n):p.source_account_id});
      const o=outcomes.find(o=>o.matchId===m.id)!;if(o.status!=='verified')throw Error('fixture');
      e.outcomes.push({...o,matchId:id,outcomeReceiptId:String(BigInt(r.id)+1000n),
        sourceEvidence:{...o.sourceEvidence,receiptId:String(BigInt(r.id)+1000n)}});
    }
  });
  return f;
}
