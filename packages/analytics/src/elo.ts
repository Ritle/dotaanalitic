export const ELO_POLICY={version:'player-mean-elo-v1',initialRating:1500,k:32,scale:400,validation:'unvalidated'} as const;
export type EloMap={matchId:string;startedAtUs:string;endedAtUs:string;availableAtUs:string;radiantPlayerIds:readonly string[];direPlayerIds:readonly string[];radiantWin:boolean};
type State={rating:number;maps:number};
export type EloSide={playerIds:string[];fingerprint:string;ratingBefore:number;priorPlayers:number;playerHistoryMaps:number[];ratingDelta:number};
export type EloObservation={matchId:string;startedAtUs:string;availableAtUs:string;radiant:EloSide;dire:EloSide;updateApplied:boolean};
const order=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const mean=(xs:readonly number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
/** Frozen start-time features; outcome updates only at evidence-backed availability. No forecast is exported. */
export function replayElo(input:readonly EloMap[],cutoffAtUs:string){
  const cutoff=BigInt(cutoffAtUs),seen=new Set<string>();
  const maps=[...input].sort((a,b)=>order(a.startedAtUs,b.startedAtUs)||order(a.matchId,b.matchId));
  for(const m of maps){
    if(!/^[1-9]\d*$/.test(m.matchId)||seen.has(m.matchId))throw new Error('duplicate_or_invalid_map');seen.add(m.matchId);
    const ids=[...m.radiantPlayerIds,...m.direPlayerIds];
    if(m.radiantPlayerIds.length!==5||m.direPlayerIds.length!==5||new Set(ids).size!==10||ids.some(id=>!/^[1-9]\d*$/.test(id)))throw new Error('invalid_canonical_fives');
    if(BigInt(m.startedAtUs)<0n||BigInt(m.endedAtUs)<=BigInt(m.startedAtUs)||BigInt(m.availableAtUs)<BigInt(m.endedAtUs))throw new Error('invalid_map_clocks');
  }
  const players=new Map<string,State>(),observations:EloObservation[]=[],pending:{map:EloMap;row:EloObservation}[]=[];
  const state=(id:string)=>players.get(id)??{rating:ELO_POLICY.initialRating,maps:0};
  function applyThrough(time:bigint){
    pending.sort((a,b)=>order(a.map.availableAtUs,b.map.availableAtUs)||order(a.map.matchId,b.map.matchId));
    while(pending.length&&BigInt(pending[0]!.map.availableAtUs)<=time){
      const {row}=pending.shift()!;
      for(const side of [row.radiant,row.dire])for(const id of side.playerIds){const previous=state(id);players.set(id,{rating:previous.rating+side.ratingDelta,maps:previous.maps+1});}
      row.updateApplied=true;
    }
  }
  for(const m of maps){
    const start=BigInt(m.startedAtUs);if(start>=cutoff)continue;
    applyThrough(start);
    const side=(ids:readonly string[]):EloSide=>{const sorted=[...ids].sort(order),states=sorted.map(state);
      return {playerIds:sorted,fingerprint:sorted.join(':'),ratingBefore:mean(states.map(s=>s.rating)),priorPlayers:states.filter(s=>s.maps===0).length,
        playerHistoryMaps:states.map(s=>s.maps),ratingDelta:0};};
    const radiant=side(m.radiantPlayerIds),dire=side(m.direPlayerIds);
    const expected=1/(1+10**((dire.ratingBefore-radiant.ratingBefore)/ELO_POLICY.scale));
    radiant.ratingDelta=ELO_POLICY.k*((m.radiantWin?1:0)-expected);dire.ratingDelta=-radiant.ratingDelta;
    const row:EloObservation={matchId:m.matchId,startedAtUs:m.startedAtUs,availableAtUs:m.availableAtUs,radiant,dire,updateApplied:false};
    observations.push(row);pending.push({map:m,row});
  }
  applyThrough(cutoff);
  return {policy:ELO_POLICY,observations,players:[...players].sort(([a],[b])=>order(a,b)).map(([playerId,s])=>({playerId,...s}))};
}
