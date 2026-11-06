export type RankedHeroMap={matchId:string;accountId:string;heroId:string;startedAt:string;completedAt:string;win:boolean};
type Totals={games:number;wins:number;winRate:number|null;lastPlayedAt:string|null};
/** Unweighted descriptive frequencies for one account and one already selected pub cohort. */
export function rankedHeroSummary(maps:readonly RankedHeroMap[],scope:{accountId:string;fromAt:string;cutoffAt:string}){
 const from=Date.parse(scope.fromAt),cutoff=Date.parse(scope.cutoffAt);
 if(!Number.isFinite(from)||!Number.isFinite(cutoff)||from>=cutoff)throw Error('invalid_ranked_scope');
 const seen=new Set<string>(),groups=new Map<string,Totals>();let wins=0,lastPlayedAt:string|null=null;
 for(const m of maps){
  const start=Date.parse(m.startedAt),end=Date.parse(m.completedAt);
  if(m.accountId!==scope.accountId||!Number.isFinite(start)||!Number.isFinite(end)||start<from||start>=cutoff||end<=start||end>=cutoff||typeof m.win!=='boolean'||!/^[1-9]\d{0,18}$/.test(m.heroId))throw Error('invalid_ranked_map');
  if(seen.has(m.matchId))throw Error('duplicate_ranked_map');seen.add(m.matchId);
  const group=groups.get(m.heroId)??{games:0,wins:0,winRate:null,lastPlayedAt:null};group.games++;group.wins+=m.win?1:0;
  if(group.lastPlayedAt===null||start>Date.parse(group.lastPlayedAt))group.lastPlayedAt=m.startedAt;
  groups.set(m.heroId,group);wins+=m.win?1:0;
  if(lastPlayedAt===null||start>Date.parse(lastPlayedAt))lastPlayedAt=m.startedAt;
 }
 const heroes=[...groups].map(([heroId,g])=>({heroId,...g,winRate:g.wins/g.games})).sort((a,b)=>b.games-a.games||(BigInt(a.heroId)<BigInt(b.heroId)?-1:1));
 return {policyVersion:'ranked-hero-raw-v1' as const,roleScope:'all_roles' as const,weighted:false as const,games:maps.length,wins,winRate:maps.length?wins/maps.length:null,lastPlayedAt,heroes};
}
