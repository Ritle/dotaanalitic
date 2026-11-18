import {z} from 'zod';
import {SeriesBestOfSchema,type SeriesBestOf} from '../../../../../packages/contracts/dist/series/forecast.js';
import {PandaResultMatchSchema} from '../scenarios/journal-result-contract.js';
const Id=z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9]\d{0,18}$/)]).transform(String);
const Time=z.iso.datetime({offset:true}).transform(t=>new Date(t).toISOString()).nullable();
const SourceSeries=PandaResultMatchSchema.extend({number_of_games:z.number().int(),match_type:z.string(),
 begin_at:Time,end_at:Time,draw:z.boolean(),game_advantage:z.unknown(),winner_id:Id.nullable(),winner_type:z.string().nullable(),
 results:z.array(z.object({team_id:Id,score:z.number().int().nonnegative()})).length(2)});
export type CheckedSeriesResult={status:'verified_provider_result';targetUnit:'series';bestOf:SeriesBestOf;teamAWon:boolean;
 startedAt:string;endedAt:string;reportedEndedAt:string;lastMapEndedAt:string;warnings:string[];scoreA:number;scoreB:number;providerGameIds:string[];canonicalProOutcome:false}|
 {status:'unavailable';targetUnit:'series';reason:string;canonicalProOutcome:false};

/** Provider-result validation only; never asserts canonical pro eligibility or creates a training example. */
export function checkPandaSeriesResult(raw:unknown,expected:{id:string;teamA:string;teamB:string},fetchedAt:string):CheckedSeriesResult{
 const fail=(reason:string):CheckedSeriesResult=>({status:'unavailable',targetUnit:'series',reason,canonicalProOutcome:false});
 const parsed=SourceSeries.safeParse(raw);if(!parsed.success)return fail('SERIES_SOURCE_INVALID');const m=parsed.data;
 const teams=m.opponents.map(o=>o.opponent.id);
 if(m.id!==expected.id||expected.teamA===expected.teamB||new Set(teams).size!==2||!teams.includes(expected.teamA)||!teams.includes(expected.teamB))return fail('SERIES_PARTICIPANTS_CHANGED');
 const format=SeriesBestOfSchema.safeParse(m.number_of_games);
 if(!format.success||m.match_type!=='best_of')return fail('SERIES_FORMAT_UNSUPPORTED');
 if(m.status!=='finished')return fail('SERIES_NOT_FINISHED');
 if(m.forfeit!==false||m.draw||m.game_advantage!==null)return fail('SERIES_TECHNICAL_OR_ADVANTAGE');
 if(!m.begin_at||!m.end_at||Date.parse(m.end_at)<=Date.parse(m.begin_at)||!Number.isFinite(Date.parse(fetchedAt))||Date.parse(m.end_at)>Date.parse(fetchedAt))return fail('SERIES_CLOCKS_UNVERIFIED');
 const games=[...(m.games??[])].sort((a,b)=>a.position-b.position),wins=Math.floor(format.data/2)+1;
 if(games.length>format.data||new Set(games.map(g=>g.id)).size!==games.length||new Set(games.map(g=>g.position)).size!==games.length||games.some(g=>g.match_id!==m.id||g.position>format.data))return fail('SERIES_GAME_CONFLICT');
 let a=0,b=0,lastEnd=Date.parse(m.begin_at);const ids:string[]=[];
 for(const g of games){
  if(a===wins||b===wins){
   if(!['not_started','canceled'].includes(g.status)||g.winner?.id||g.begin_at||g.end_at)return fail('SERIES_GAME_AFTER_DECISION');
   continue;
  }
  if(g.position!==ids.length+1||g.status!=='finished'||g.finished!==true||g.forfeit!==false||!g.winner?.id||!teams.includes(g.winner.id))return fail('SERIES_MAPS_INCOMPLETE');
  if(!g.begin_at||!g.end_at||Date.parse(g.begin_at)<lastEnd||Date.parse(g.end_at)<=Date.parse(g.begin_at)||Date.parse(g.end_at)>Date.parse(fetchedAt))return fail('SERIES_MAP_CLOCKS_CONFLICT');
  ids.push(g.id);lastEnd=Date.parse(g.end_at);if(g.winner.id===expected.teamA)a++;else b++;
 }
 if(a!==wins&&b!==wins)return fail('SERIES_MAPS_INCOMPLETE');
 const resultIds=m.results.map(r=>r.team_id),scoreA=m.results.find(r=>r.team_id===expected.teamA)?.score,scoreB=m.results.find(r=>r.team_id===expected.teamB)?.score;
 if(new Set(resultIds).size!==2||scoreA!==a||scoreB!==b||m.winner_type!=='Team'||m.winner_id!==(a===wins?expected.teamA:expected.teamB))return fail('SERIES_SCORE_CONFLICT');
 // Providers may timestamp the series end one second before the final map end. Retain both
 // clocks and take the later completion boundary; never invent a timestamp or an arbitrary tolerance.
 const warnings=lastEnd>Date.parse(m.end_at)?['SERIES_END_BEFORE_LAST_MAP_END']:[];
 return {status:'verified_provider_result',targetUnit:'series',bestOf:format.data,teamAWon:a===wins,startedAt:m.begin_at,endedAt:new Date(Math.max(lastEnd,Date.parse(m.end_at))).toISOString(),
  reportedEndedAt:m.end_at,lastMapEndedAt:new Date(lastEnd).toISOString(),warnings,
  scoreA:a,scoreB:b,providerGameIds:ids,canonicalProOutcome:false};
}
