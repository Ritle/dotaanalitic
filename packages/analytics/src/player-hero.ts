import {aggregateKda} from './index.js';
import {sampleEvidence} from './sample.js';
export type PlayerHeroObservation={matchId:string;heroId:string|null;rolePos:number|null;won:boolean;startedAt:string;syncedAt:string;
  kills:number|null;deaths:number|null;assists:number|null;gpm:number|null;xpm:number|null};
/** Caller supplies one verified, completed pro observation per map. Missing fields retain separate denominators. */
export function playerHeroSample(maps:readonly PlayerHeroObservation[]){
  if(new Set(maps.map(m=>m.matchId)).size!==maps.length)throw new Error('duplicate_player_map');
  const mean=(field:'kills'|'deaths'|'assists'|'gpm'|'xpm')=>{
    const values=maps.flatMap(m=>m[field]===null?[]:[m[field]]);
    return {value:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,nMaps:values.length};
  };
  const complete=maps.flatMap(m=>m.kills!==null&&m.deaths!==null&&m.assists!==null?[{kills:m.kills,deaths:m.deaths,assists:m.assists}]:[]);
  const wins=maps.filter(m=>m.won).length;
  return {nRaw:maps.length,wins,winRate:maps.length?wins/maps.length:null,kda:{value:aggregateKda(complete),nMaps:complete.length},
    meanKills:mean('kills'),meanDeaths:mean('deaths'),meanAssists:mean('assists'),meanGpm:mean('gpm'),meanXpm:mean('xpm'),
    lastPlayedAt:maps.map(m=>m.startedAt).sort().at(-1)??null,dataUpdatedAt:maps.map(m=>m.syncedAt).sort().at(-1)??null,sampleEvidence:sampleEvidence(maps.length)};
}
