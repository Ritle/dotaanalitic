import {sql,type Db} from './index.js';
import {rankedHeroSummary} from '@dota/analytics';
import {RankedPracticeHeroSummarySchema,RANKED_PRACTICE_ADAPTER_VERSION,type RankedPracticeObservation} from '@dota/contracts';
/** Source gate follows the documented nonempty OpenDota v2 audit, never player-specific rules. */
export async function describeRankedPracticeHeroes(db:Db,observationId:string,observation:RankedPracticeObservation){
 if(observation.provider!=='opendota'||observation.adapterVersion!==RANKED_PRACTICE_ADAPTER_VERSION||observation.coverage.conflicts>0)return null;
 const summary=rankedHeroSummary(observation.maps,{accountId:observation.accountId,fromAt:observation.fromAt,cutoffAt:observation.cutoffAt});
 const ids=summary.heroes.map(h=>h.heroId),names=ids.length?(await sql<{id:string;name:string|null}>`SELECT id::text,localized_name AS name FROM heroes WHERE id=ANY(${ids}::bigint[])`.execute(db)).rows:[];
 const byId=new Map(names.map(h=>[h.id,h.name]));
 return RankedPracticeHeroSummarySchema.parse({...summary,observationId,heroes:summary.heroes.map(h=>({...h,heroName:byId.get(h.heroId)??null}))});
}
