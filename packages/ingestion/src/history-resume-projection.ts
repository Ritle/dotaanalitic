import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CatalogIdSchema} from '@dota/contracts';
import {HeroesSchema,LeaguesSchema,MatchSchema} from './opendota/schemas.js';
import {classifyLeague,completedObservation,parseSource} from './quality.js';
import type {ProviderObservation} from './opendota/client.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Reference=z.object({id:CatalogIdSchema,endpoint:z.string(),payload:z.unknown(),payloadSha256:Sha,fetchedAt:Time});
export const StoredHistoryProjectionSchema=z.object({matchId:CatalogIdSchema,receiptId:CatalogIdSchema,payloadSha256:Sha,fetchedAt:Time,eventAt:Time,
 isPro:z.literal(true),status:z.enum(['accepted','partial']),projection:z.unknown(),heroes:Reference,leagues:Reference});
export const HISTORY_PROJECTION_ADAPTER='stored-history-projection-v1';
/** These are derived bytes, never a reconstruction of the provider's original SHA. */
export function prepareStoredHistoryProjection(input:unknown,derivedAt:string){
 const p=StoredHistoryProjectionSchema.parse(input);Time.parse(derivedAt);
 if([p.fetchedAt,p.heroes.fetchedAt,p.leagues.fetchedAt].some(t=>t>derivedAt)||p.heroes.endpoint!=='/heroes'||p.leagues.endpoint!=='/leagues')throw Error('stored_projection_context');
 const manifest={kind:'stored_receipt_projection' as const,parentReceiptId:p.receiptId,parentPayloadSha256:p.payloadSha256,parentFetchedAt:p.fetchedAt,
  parentHeroReferenceId:p.heroes.id,parentLeagueReferenceId:p.leagues.id,derivedAt};
 const observation=<T>(endpoint:string,data:T,body:unknown=data):ProviderObservation<T>=>{
  const rawBody=JSON.stringify(body);return {data,rawBody,source:{provider:'opendota',endpoint,adapterVersion:HISTORY_PROJECTION_ADAPTER,fetchedAt:derivedAt,knownAt:null,
   payloadSha256:createHash('sha256').update(rawBody).digest('hex'),attempts:0,rateLimitRemaining:{minute:null,day:null,month:null}}};
 };
 const parsed=MatchSchema.parse(p.projection),heroes=HeroesSchema.parse(p.heroes.payload),leagues=LeaguesSchema.parse(p.leagues.payload);
 const players=parsed.players??[],slots=players.map(p=>p.player_slot),accounts=players.map(p=>p.account_id),native=[0,1,2,3,4,128,129,130,131,132];
 const league=leagues.filter(l=>l.leagueid===parsed.leagueid);
 if(parsed.match_id!==p.matchId||parsed.start_time==null||new Date(parsed.start_time*1000).toISOString()!==p.eventAt||!completedObservation(parsed,p.fetchedAt)||
  players.length!==10||native.some(n=>!slots.includes(n))||accounts.some(a=>!a||BigInt(a)>=4294967295n)||new Set(accounts).size!==10||
  league.length!==1||classifyLeague(league[0]!.tier)!==true)throw Error('stored_projection_not_eligible');
 const match=observation('/matches/'+p.matchId,parsed,{...(p.projection as Record<string,unknown>),_history_projection:manifest});
 if(!parseSource(match,p.matchId).match)throw Error('stored_projection_invalid');
 return {match,heroes:observation('/heroes',heroes),leagues:observation('/leagues',leagues),manifest};
}
