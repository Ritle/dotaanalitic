export type HeroPairMap={matchId:string;radiantWin:boolean;heroes:readonly {heroId:number;side:'radiant'|'dire'}[]};
/** One eligible map contributes at most once to a pair. Enemy wins follow hero A. */
export function pairObservations<T extends HeroPairMap>(maps:readonly T[],kind:'ally'|'enemy',heroA:number,heroB:number){
  if(heroA===heroB||[heroA,heroB].some(h=>!Number.isInteger(h)||h<=0||h>2147483647))throw new Error('invalid_pair');
  const seen=new Set<string>(),rows:{map:T;won:boolean}[]=[];
  for(const map of maps){
    if(seen.has(map.matchId))throw new Error('duplicate_pair_map');seen.add(map.matchId);
    if(new Set(map.heroes.map(h=>h.heroId)).size!==map.heroes.length)throw new Error('ambiguous_pair_heroes');
    const a=map.heroes.find(h=>h.heroId===heroA),b=map.heroes.find(h=>h.heroId===heroB);
    if(a&&b&&(kind==='ally'?a.side===b.side:a.side!==b.side))rows.push({map,won:a.side==='radiant'?map.radiantWin:!map.radiantWin});
  }
  return rows;
}
