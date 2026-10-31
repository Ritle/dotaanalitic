import type {HeroPairMap} from './hero-pairs.js';
type MetaMap=HeroPairMap&{patchId:string|null;syncedAt:string};
/** Observed WR may use partial maps; pick share uses complete ten-hero maps only. */
export function heroMetaSample(maps:readonly MetaMap[],heroId:number){
  if(!Number.isInteger(heroId)||heroId<=0||heroId>2147483647)throw new Error('invalid_meta_hero');
  if(new Set(maps.map(m=>m.matchId)).size!==maps.length)throw new Error('duplicate_meta_map');
  for(const m of maps)if(new Set(m.heroes.map(h=>h.heroId)).size!==m.heroes.length)throw new Error('ambiguous_meta_heroes');
  const rows=maps.filter(m=>m.heroes.some(h=>h.heroId===heroId)),complete=maps.filter(m=>m.heroes.length===10),knownDraftPicks=complete.filter(m=>m.heroes.some(h=>h.heroId===heroId)).length;
  const wins=rows.filter(m=>m.heroes.find(h=>h.heroId===heroId)!.side==='radiant'?m.radiantWin:!m.radiantWin).length;
  const distribution=new Map<string|null,number>();for(const m of rows)distribution.set(m.patchId,(distribution.get(m.patchId)??0)+1);
  return {nRaw:rows.length,wins,winRate:rows.length?wins/rows.length:null,knownDraftPicks,completeDraftMaps:complete.length,pickRate:complete.length?knownDraftPicks/complete.length:null,
    patchDistribution:[...distribution].map(([patchId,nRaw])=>({patchId,nRaw})),dataUpdatedAt:rows.map(m=>m.syncedAt).sort().at(-1)??null};
}
