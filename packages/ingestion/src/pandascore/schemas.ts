import {z} from 'zod';

export const PandaIdSchema=z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9]\d{0,18}$/)])
  .transform(String).refine(id=>BigInt(id)<=9223372036854775807n);
const Label=z.string().max(200).transform(value=>value.trim()||null).nullable();
const Time=z.iso.datetime({offset:true}).transform(s=>new Date(s).toISOString()).nullable();
const Reference=z.object({id:PandaIdSchema,name:Label});
const Game=z.object({slug:z.literal('dota-2')});
export const PandaUpcomingSchema=z.array(z.object({
  id:PandaIdSchema,name:Label,status:z.string().min(1).max(40),scheduled_at:Time,
  tournament:Reference,league:Reference,serie:Reference.extend({full_name:Label.optional()}).optional(),number_of_games:z.number().int().min(1).max(20).nullable(),
  videogame:Game.optional(),
  opponents:z.array(z.object({type:z.literal('Team'),opponent:Reference})).max(2)
})).max(20).superRefine((rows,ctx)=>{
  if(new Set(rows.map(r=>r.id)).size!==rows.length)ctx.addIssue({code:'custom',message:'duplicate_match'});
  for(const row of rows)if(new Set(row.opponents.map(o=>o.opponent.id)).size!==row.opponents.length)
    ctx.addIssue({code:'custom',message:'duplicate_opponent'});
}).transform(rows=>rows.map(m=>({providerMatchId:m.id,name:m.name,status:m.status,scheduledAt:m.scheduled_at,
  tournament:{providerTournamentId:m.tournament.id,name:m.tournament.name},
  league:{providerLeagueId:m.league.id,name:m.league.name},
  eventSeries:m.serie?{providerEventSeriesId:m.serie.id,name:m.serie.full_name??m.serie.name}:null,seriesBestOf:m.number_of_games,
  opponents:m.opponents.map(o=>({providerTeamId:o.opponent.id,name:o.opponent.name}))})));

export const PandaRostersSchema=z.object({type:z.literal('Team'),rosters:z.array(z.object({
  id:PandaIdSchema,name:Label,current_videogame:Game.optional(),
  players:z.array(z.object({id:PandaIdSchema,name:Label})).max(30)
})).max(100)}).superRefine((value,ctx)=>{
  if(new Set(value.rosters.map(r=>r.id)).size!==value.rosters.length)ctx.addIssue({code:'custom',message:'duplicate_roster_team'});
  const ids=value.rosters.flatMap(r=>r.players.map(p=>p.id));
  if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'duplicate_roster_player'});
}).transform(value=>value.rosters.map(team=>({providerTeamId:team.id,name:team.name,
  players:team.players.map(p=>({providerPlayerId:p.id,name:p.name}))})));
export type PandaUpcoming=z.output<typeof PandaUpcomingSchema>;
export type PandaRosters=z.output<typeof PandaRostersSchema>;

/** Field names/types only; this endpoint's provider ID is never interpreted as a Steam account. */
export const PandaPlayerIdentifierInventorySchema=z.record(z.string(),z.unknown()).superRefine((raw,ctx)=>{
  if(!PandaIdSchema.safeParse(raw.id).success)ctx.addIssue({code:'custom',message:'invalid_profile_id'});
}).transform(raw=>{
  const identifierFields:{path:string;type:string}[]=[];
  function walk(value:Record<string,unknown>,prefix:string,depth:number){
    for(const [key,item] of Object.entries(value).slice(0,100)){
      const path=prefix?prefix+'.'+key:key;
      if(/(?:^|_)(?:id|steam|account|steamid)(?:_|$)/i.test(key))identifierFields.push({path,type:item===null?'null':Array.isArray(item)?'array':typeof item});
      if(depth<3&&item!==null&&typeof item==='object'&&!Array.isArray(item))walk(item as Record<string,unknown>,path,depth+1);
    }
  }
  walk(raw,'',0);
  return {providerPlayerId:PandaIdSchema.parse(raw.id),identifierFields:identifierFields.sort((a,b)=>a.path.localeCompare(b.path)),
    scope:'field_inventory_only' as const,canonicalPlayerId:null,steamAccountId:null};
});
