import {z} from 'zod';
const Id=z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9]\d{0,18}$/)]).transform(String);
const Time=z.iso.datetime({offset:true}).transform(v=>new Date(v).toISOString()).nullable();
const Winner=z.object({id:Id.nullable(),type:z.literal('Team')}).nullable();
export const PandaResultMatchSchema=z.object({id:Id,name:z.string().nullable(),status:z.string(),
 videogame:z.object({slug:z.literal('dota-2')}),forfeit:z.boolean().optional(),
 opponents:z.array(z.object({type:z.literal('Team'),opponent:z.object({id:Id,name:z.string().nullable()})})).max(2),
 games:z.array(z.object({id:Id,match_id:Id,position:z.number().int().positive(),status:z.string(),
  finished:z.boolean().optional(),forfeit:z.boolean().optional(),begin_at:Time.optional(),end_at:Time.optional(),winner:Winner.optional()})).max(20).optional()
});
export const JournalResultSchema=z.object({provider:z.literal('pandascore'),providerMatchId:z.string(),
 state:z.enum(['finished','not_started','running','postponed','cancelled','unresolved','unavailable']),
 actualWinner:z.enum(['A','B']).nullable(),correct:z.boolean().nullable(),providerGameId:z.string().nullable(),
 beganAt:Time,endedAt:Time,sourceFetchedAt:Time,sourceSha256:z.string().nullable(),sourceUrl:z.string(),
 reason:z.string(),canonicalOutcome:z.literal(false)
}).strict();
export type JournalResult=z.infer<typeof JournalResultSchema>;
export type ResultTarget={providerMatchId:string;teamA:string;teamB:string;probability:number|null;issuedAt:string|null;createdAt:string;cutoffAt:string};
/** Only explicit map position 1, numeric team identity and pre-start issuance permit a verdict. */
export function assessPandaResult(raw:unknown,target:ResultTarget,source:{fetchedAt:string;payloadSha256:string}):JournalResult{
 const m=PandaResultMatchSchema.parse(raw),base:JournalResult={provider:'pandascore',providerMatchId:target.providerMatchId,state:'unresolved',
  actualWinner:null,correct:null,providerGameId:null,beganAt:null,endedAt:null,sourceFetchedAt:source.fetchedAt,
  sourceSha256:source.payloadSha256,sourceUrl:`https://api.pandascore.co/matches/${target.providerMatchId}`,reason:'FIRST_MAP_UNCONFIRMED',canonicalOutcome:false};
 const teams=m.opponents.map(o=>o.opponent.id);
 if(m.id!==target.providerMatchId||teams.length!==2||new Set(teams).size!==2||!teams.includes(target.teamA)||!teams.includes(target.teamB))return {...base,reason:'PARTICIPANTS_CHANGED'};
 const games=m.games??[],first=games.filter(g=>g.position===1);
 if(first.length!==1){
  if(first.length>1)return {...base,reason:'FIRST_MAP_AMBIGUOUS'};
  const state=m.status==='not_started'?'not_started':m.status==='running'?'running':m.status==='postponed'?'postponed':m.status==='canceled'?'cancelled':'unresolved';
  return {...base,state,reason:state==='unresolved'?'FINISHED_WITHOUT_FIRST_MAP':'FIRST_MAP_NOT_FINISHED'};
 }
 const g=first[0]!;
 if(games.some(game=>game.match_id!==m.id)||new Set(games.map(game=>game.id)).size!==games.length)return {...base,reason:'GAME_IDENTITY_CONFLICT'};
 const detail={...base,providerGameId:g.id,beganAt:g.begin_at??null,endedAt:g.end_at??null};
 if(m.forfeit||g.forfeit||m.status==='canceled'||g.status==='canceled')return {...detail,state:'cancelled',reason:'FORFEIT_OR_CANCELLED'};
 if(m.status==='postponed'&&g.status!=='finished')return {...detail,state:'postponed',reason:'FIRST_MAP_NOT_FINISHED'};
 if(g.status!=='finished'||g.finished===false)return {...detail,state:g.status==='running'?'running':g.status==='not_started'?'not_started':'unresolved',reason:'FIRST_MAP_NOT_FINISHED'};
 if(!['finished','running'].includes(m.status)||g.forfeit!==false)return {...detail,reason:'GAME_COMPLETION_UNCONFIRMED'};
 const winner=g.winner?.id;
 if(!winner||!teams.includes(winner))return {...detail,reason:'FIRST_MAP_WINNER_MISSING'};
 const actualWinner=winner===target.teamA?'A':'B',finished={...detail,state:'finished' as const,actualWinner:actualWinner as 'A'|'B'};
 if(!g.begin_at||!g.end_at||Date.parse(g.end_at)<=Date.parse(g.begin_at)||Date.parse(g.end_at)>Date.parse(source.fetchedAt))return {...detail,reason:'GAME_TIME_UNCONFIRMED'};
 if(target.probability===null||target.issuedAt===null)return {...finished,reason:'NO_ISSUED_PROBABILITY'};
 if(Date.parse(target.issuedAt)>=Date.parse(g.begin_at)||Date.parse(target.createdAt)>=Date.parse(g.begin_at)||Date.parse(target.cutoffAt)>Date.parse(g.begin_at))return {...finished,reason:'NOT_BEFORE_MAP_START'};
 if(target.probability===.5)return {...finished,reason:'NO_FAVOURITE'};
 return {...finished,correct:(target.probability>.5?'A':'B')===actualWinner,reason:'PROVIDER_FIRST_MAP_RESULT'};
}
