import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
const Time=z.iso.datetime({precision:3});
export const RANKED_PRACTICE_ADAPTER_VERSION='ranked-practice-reader-v2' as const;
export const RankedProviderSchema=z.enum(['opendota','stratz']);
export const RankedPracticeRequestSchema=z.object({playerId:Id,provider:RankedProviderSchema.default('opendota'),refresh:z.boolean().default(false)}).strict();
export const RankedPracticeMapSchema=z.object({matchId:Id,accountId:Id,heroId:Id,startedAt:Time,completedAt:Time,
 completionBasis:z.enum(['provider_end','start_plus_duration']),side:z.enum(['radiant','dire']),win:z.boolean(),
 patchCode:z.string().max(30).nullable(),position:z.string().max(40).nullable(),roleBasis:z.enum(['estimated','unknown']),
 averageRank:z.number().int().positive().nullable(),partySize:z.number().int().min(1).max(5).nullable()}).strict();
export const RankedPracticeObservationSchema=z.object({adapterVersion:z.enum(['ranked-practice-reader-v1',RANKED_PRACTICE_ADAPTER_VERSION]),provider:RankedProviderSchema,accountId:Id,
 fromAt:Time,cutoffAt:Time,knownAt:z.null(),fetchedAt:Time,
 filters:z.object({lobbyTypeId:z.literal(7),gameModeId:z.literal(22),windowDays:z.literal(30),qualityFilter:z.literal('none')}).strict(),
 maps:z.array(RankedPracticeMapSchema).max(200),coverage:z.object({receivedRows:z.number().int().min(0).max(200),
 excluded:z.record(z.string().max(60),z.number().int().nonnegative()),duplicates:z.number().int().nonnegative(),conflicts:z.number().int().nonnegative(),
 pagination:z.enum(['exhausted','capped','interrupted']),historyCompleteness:z.literal('unknown'),stopReason:z.string().max(60).nullable()}).strict(),
 receipts:z.array(z.object({offset:z.number().int().nonnegative(),rows:z.number().int().min(0).max(100),fetchedAt:Time,payloadSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(2)
}).strict().superRefine((v,c)=>{
 const from=Date.parse(v.fromAt),cutoff=Date.parse(v.cutoffAt);
 if(cutoff-from!==30*86400000||Date.parse(v.fetchedAt)<cutoff)c.addIssue({code:'custom',message:'Invalid observation window'});
 if(v.maps.some(m=>m.accountId!==v.accountId||Date.parse(m.startedAt)<from||Date.parse(m.startedAt)>=cutoff||Date.parse(m.completedAt)<=Date.parse(m.startedAt)||Date.parse(m.completedAt)>=cutoff))
  c.addIssue({code:'custom',message:'Invalid observation map'});
 if(new Set(v.maps.map(m=>m.matchId)).size!==v.maps.length)c.addIssue({code:'custom',message:'Duplicate observation maps'});
});
const RankedTotals=z.object({games:z.number().int().min(0).max(200),wins:z.number().int().min(0).max(200),winRate:z.number().min(0).max(1).nullable(),lastPlayedAt:Time.nullable()}).superRefine((v,c)=>{
 if(v.wins>v.games||v.games===0&&(v.winRate!==null||v.lastPlayedAt!==null)||v.games>0&&(v.winRate===null||Math.abs(v.winRate-v.wins/v.games)>1e-12||v.lastPlayedAt===null))c.addIssue({code:'custom',message:'Invalid ranked totals'});
});
export const RankedPracticeHeroSummarySchema=RankedTotals.safeExtend({observationId:z.uuid(),policyVersion:z.literal('ranked-hero-raw-v1'),roleScope:z.literal('all_roles'),weighted:z.literal(false),
 heroes:z.array(RankedTotals.safeExtend({heroId:Id,heroName:z.string().max(300).nullable()})).max(200)}).superRefine((v,c)=>{
 if(v.heroes.some(h=>h.games===0)||new Set(v.heroes.map(h=>h.heroId)).size!==v.heroes.length||v.heroes.reduce((n,h)=>n+h.games,0)!==v.games||v.heroes.reduce((n,h)=>n+h.wins,0)!==v.wins)
  c.addIssue({code:'custom',message:'Invalid ranked hero groups'});
});
export const RankedPracticeReportSchema=z.object({playerId:Id,accountId:Id.nullable(),provider:RankedProviderSchema,snapshotAt:Time,
 identityRevision:z.string().regex(/^\d+$/),observationIdentityRevision:z.string().regex(/^\d+$/).nullable(),
 identityStatus:z.enum(['verified','unknown','conflict']),status:z.enum(['not_loaded','ready','partial','empty','unavailable','conflict']),
 stale:z.boolean(),reason:z.string().max(60).nullable(),retryAt:Time.nullable(),observationId:z.uuid().nullable(),
 observation:RankedPracticeObservationSchema.nullable(),statisticsEnabled:z.boolean(),heroSummary:RankedPracticeHeroSummarySchema.nullable().default(null)}).strict().superRefine((v,c)=>{
 if(v.statisticsEnabled!==Boolean(v.heroSummary))c.addIssue({code:'custom',message:'Invalid statistics availability'});
 if(v.heroSummary&&(v.provider!=='opendota'||v.identityStatus!=='verified'||!v.observation||v.observation.adapterVersion!==RANKED_PRACTICE_ADAPTER_VERSION||v.observation.coverage.conflicts>0||v.heroSummary.observationId!==v.observationId||v.heroSummary.games!==v.observation.maps.length||['not_loaded','unavailable','conflict'].includes(v.status)))
  c.addIssue({code:'custom',message:'Invalid ranked statistics source'});
 if(v.heroSummary&&v.observation){
  const o=v.observation,s=v.heroSummary,latest=o.maps.reduce<string|null>((last,m)=>last===null||m.startedAt>last?m.startedAt:last,null);
  if(o.provider!==v.provider||o.accountId!==v.accountId||s.lastPlayedAt!==latest||s.heroes.some(h=>{
   const maps=o.maps.filter(m=>m.heroId===h.heroId),last=maps.reduce<string|null>((prev,m)=>prev===null||m.startedAt>prev?m.startedAt:prev,null);
   return maps.length!==h.games||maps.filter(m=>m.win).length!==h.wins||h.lastPlayedAt!==last;
  }))c.addIssue({code:'custom',message:'Ranked summary does not match observation'});
 }
});
export type RankedProvider=z.infer<typeof RankedProviderSchema>;
export type RankedPracticeRequest=z.infer<typeof RankedPracticeRequestSchema>;
export type RankedPracticeMap=z.infer<typeof RankedPracticeMapSchema>;
export type RankedPracticeObservation=z.infer<typeof RankedPracticeObservationSchema>;
export type RankedPracticeReport=z.infer<typeof RankedPracticeReportSchema>;
export type RankedPracticeHeroSummary=z.infer<typeof RankedPracticeHeroSummarySchema>;
