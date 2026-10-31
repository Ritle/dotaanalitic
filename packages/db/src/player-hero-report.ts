import {playerHeroSample,type PlayerHeroObservation} from '@dota/analytics';
import {PlayerHeroReportSchema,type PlayerHeroQuery,type StoredAccountEvidence,type GameRegistry} from '@dota/contracts';
import {collectProMaps,type ProMapCandidate} from './pro-maps.js';
import {resolvePatchAt} from './game-context.js';
export type EffectivePlayerHeroQuery=PlayerHeroQuery & {fromAt:string;cutoffAt:string};
export function playerHeroMetadata(playerId:string,filters:EffectivePlayerHeroQuery,snapshotAt:string){
  return {playerId,filters,fromAt:filters.fromAt,cutoffAt:filters.cutoffAt,snapshotAt,source:'normalized_local_maps' as const,
    policyVersion:'player-hero-display-v1' as const,scope:'retrospective_descriptive' as const,model:null,predictionEligibility:'not_assessed' as const};
}
export function buildPlayerHeroReport(playerId:string,query:EffectivePlayerHeroQuery,snapshotAt:string,candidates:readonly ProMapCandidate[],
  evidence:readonly StoredAccountEvidence[],registry:GameRegistry,identityRevision:string,heroNames:ReadonlyMap<string,string>){
  const metadata=playerHeroMetadata(playerId,query,snapshotAt);
  const current=query.patchScope==='current'?resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),query.cutoffAt,snapshotAt).value:null;
  if(query.patchScope==='current'&&current===null)return {...metadata,status:'unavailable' as const,reason:'CURRENT_PATCH_UNKNOWN' as const,
    message:'Патч на дату среза не подтверждён. Выберите все патчи или конкретный проверенный патч.'};
  const effectivePatchId=query.patchScope==='specific'?query.patchId!:current;
  const {eligible,coverage}=collectProMaps('players',playerId,{...query,patchId:effectivePatchId??undefined,limit:100},snapshotAt,candidates,registry,evidence);
  const byId=new Map(candidates.map(m=>[m.matchId,m]));
  const valid=(n:number|null|undefined,max:number)=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=max?n:null;
  const base=eligible.map(({targetPlayerSlot,...m})=>{
    const source=byId.get(m.matchId)!,p=source.players.find(p=>p.playerSlot===targetPlayerSlot)!;
    const hero=valid(p.heroId,2147483647),heroId=hero!==null&&hero>0&&source.players.filter(p=>p.heroId===hero).length===1?String(hero):null;
    return {...m,heroId,stats:{kills:valid(p.kills,32767),deaths:valid(p.deaths,32767),assists:valid(p.assists,32767),gpm:valid(p.gpm,2147483647),xpm:valid(p.xpm,2147483647)}};
  });
  const maps=base.filter(m=>!query.heroId||m.heroId===query.heroId);
  const observations:PlayerHeroObservation[]=maps.map(m=>({matchId:m.matchId,heroId:m.heroId,rolePos:m.rolePos,won:m.won,startedAt:m.startedAt,syncedAt:m.syncedAt,...m.stats}));
  const summary=playerHeroSample(observations),groups=new Map<string,PlayerHeroObservation[]>(),distribution=new Map<string|null,number>();
  for(const m of observations){const key=`${m.heroId??'unknown'}:${m.rolePos??'unknown'}`,group=groups.get(key)??[];group.push(m);groups.set(key,group);}
  for(const m of maps)distribution.set(m.patchId,(distribution.get(m.patchId)??0)+1);
  const warnings=[...new Set(['RETROSPECTIVE_NOT_HISTORICAL_FEATURES','LOCAL_HISTORY_NOT_EXHAUSTIVE',...maps.flatMap(m=>m.warnings)])];
  if(maps.some(m=>m.heroId===null))warnings.push('HERO_UNKNOWN_OR_CONFLICT');
  if([summary.kda,summary.meanKills,summary.meanDeaths,summary.meanAssists,summary.meanGpm,summary.meanXpm].some(s=>s.nMaps<summary.nRaw))warnings.push('METRIC_COVERAGE_PARTIAL');
  if(coverage.identityUnresolved)warnings.push('UNRESOLVED_PLAYER_MAPS');
  if(!maps.length)warnings.push('NO_ELIGIBLE_PLAYER_HERO_MAPS');
  return PlayerHeroReportSchema.parse({...metadata,status:maps.length?'ready':'insufficient_data',identityRevision,registryRevision:registry.revision,effectivePatchId,
    summary,playerMapsInScope:base.length,selectedHeroShare:base.length?maps.length/base.length:null,
    groups:[...groups.values()].map(rows=>{const {heroId,rolePos}=rows[0]!,heroMaps=base.filter(m=>m.heroId===heroId).length;
      return {...playerHeroSample(rows),heroId,heroName:heroId===null?null:heroNames.get(heroId)??null,rolePos,heroMaps,heroPickRate:base.length?heroMaps/base.length:null};
    }).sort((a,b)=>b.nRaw-a.nRaw||(a.heroId===b.heroId?(a.rolePos??6)-(b.rolePos??6):a.heroId===null?1:b.heroId===null?-1:BigInt(a.heroId)<BigInt(b.heroId)?-1:1)),
    coverage:{candidates:coverage.candidates,unknownPro:coverage.unknownPro,nonPro:coverage.nonPro,conflict:coverage.conflict,unfinished:coverage.unfinished,
      identityUnresolved:coverage.identityUnresolved,filterMismatch:coverage.filterMismatch,heroFilterMismatch:base.length-maps.length,
      knownHero:maps.filter(m=>m.heroId!==null).length,confirmedRole:maps.filter(m=>m.rolePos!==null).length,knownPatch:maps.filter(m=>m.patchId!==null).length,
      lateFetchedMaps:maps.filter(m=>m.sourceFetchedAt!==null&&m.sourceFetchedAt>query.cutoffAt).length,sourceFetchUnknown:maps.filter(m=>m.sourceFetchedAt===null).length},
    patchDistribution:[...distribution].map(([patchId,maps])=>({patchId,maps})),maps,warnings});
}
