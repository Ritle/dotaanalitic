import {createHash} from 'node:crypto';
import {z} from 'zod';
import {IdentityProvisioner,SeriesProvisionRepository,RosterCatalogueRepository,readAccountEvidence,resolveIdentity,V1DataRepository,prepareReleaseHistory,type Db} from '@dota/db';
import {readV1RuntimeCode} from '../../db/dist/v1-runtime-code.js';
import {ReviewedCurrentAccountsSchema,HistoryEnrichmentSchema,type HistoryEnrichment,type PlayerHistoryBinding,type ProvisionBatch} from '@dota/contracts';
import {createV1FeatureBuilder} from '@dota/prediction';
import {ProPlayersSchema} from './opendota/schemas.js';
import {prepareCurrentProfile} from './opendota/current-profile.js';
import {CatalogueObservationSchema,catalogueCandidates,catalogueProfileCandidate,type CatalogueObservation} from './roster-catalogue.js';
import type {PlayerHistoryProvider} from './player-history.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const numeric=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export function historyParticipantAccounts(maps:readonly {players?:readonly {account_id?:string|null}[]|null}[]){
 return [...new Set(maps.flatMap(m=>(m.players??[]).flatMap(p=>p.account_id&&/^[1-9][0-9]*$/.test(p.account_id)&&BigInt(p.account_id)<4294967295n?[p.account_id]:[])))].sort(numeric);
}
/** Numeric proof only. Duplicate registry rows are not resolved by choosing a nickname. */
export function historyAccountReviews(input:unknown,accounts:readonly string[],reviewedAt:string){
 const o=CatalogueObservationSchema.parse(input);
 if(o.source.endpoint!=='/proPlayers'||sha(o.rawBody)!==o.source.payloadSha256||o.source.fetchedAt>reviewedAt)throw Error('history_registry_binding');
 const rows=ProPlayersSchema.parse(JSON.parse(o.rawBody)),reviews:ProvisionBatch[]=[],unresolved:string[]=[];
 for(const id of accounts){const found=rows.filter(r=>r.account_id===id),p=found[0];
  if(found.length!==1||!p?.steamid||BigInt(p.steamid)!==76561197960265728n+BigInt(id)){unresolved.push(id);continue;}
  reviews.push(ReviewedCurrentAccountsSchema.parse({schemaVersion:1,policyVersion:'reviewed-current-accounts-v1',reviewedAt,
   source:{url:'https://api.opendota.com/api/proPlayers',reportSha256:sha(JSON.stringify({observation:o,accountId:id})),payloadSha256:o.source.payloadSha256,knownAt:o.source.fetchedAt,fetchedAt:o.source.fetchedAt},
   accounts:[{accountId:id,steam64:p.steamid,alias:(p.name?.trim()||p.personaname?.trim()||`ID ${id}`).slice(0,120)}]}));
 }return {reviews,unresolved};
}
/** Shares the catalogue's durable lease/TTL/negative retry; no per-map registry calls. */
async function source(db:Db,provider:PlayerHistoryProvider,key:string){
 const repo=new RosterCatalogueRepository(db),cached=await repo.cached(key);
 const validate=(input:unknown)=>{const o=CatalogueObservationSchema.parse(input);if(key==='registry')catalogueCandidates(o,'players','');else catalogueProfileCandidate(o,key.slice(7));return o;};
 if(cached?.fresh)return validate(cached.observation);
 const token=await repo.claim(key);if(!token){const ready=await repo.cached(key);if(ready?.fresh)return validate(ready.observation);throw Error('history_source_busy');}
 try{const observation=validate(key==='registry'?await provider.getProPlayers?.():await provider.getPlayer?.(key.slice(7)));await repo.publish(key,token,observation);return observation;}
 catch(e){await repo.fail(key,token);throw e;}
}
export async function enrichHistoryEvidence(db:Db,provider:PlayerHistoryProvider,accounts:readonly string[],seriesIds:readonly string[],current:()=>Promise<boolean>,record:(value:unknown)=>void=()=>undefined){
 const id=z.string().regex(/^[1-9][0-9]*$/);z.array(id.refine(v=>BigInt(v)<4294967295n)).max(500).refine(a=>new Set(a).size===a.length).parse(accounts);
 z.array(id).max(50).parse(seriesIds);
 const result:HistoryEnrichment={status:'completed',accountsConsidered:accounts.length,accountsVerified:0,profilesRequested:0,unresolvedAccounts:[],seriesCreated:0,seriesBlocked:[],replayedMaps:0,reasons:[],assessedAt:null,players:[]};
 const check=async()=>{if(!await current())throw Error('player_history_stale_attempt');};
 await check();const evidence=await readAccountEvidence(db,accounts),missing=accounts.filter(id=>resolveIdentity(evidence,id,null).status!=='verified');
 const conflicts=missing.filter(id=>resolveIdentity(evidence,id,null).status==='conflict');
 if(conflicts.length)result.reasons.push('IDENTITY_CONFLICT');
 const pending=missing.filter(id=>!conflicts.includes(id)).slice(0,100),provision=new IdentityProvisioner(db);let registry:CatalogueObservation|null=null;
 if(pending.length&&provider.getProPlayers)try{registry=await source(db,provider,'registry');}catch{result.reasons.push('REGISTRY_UNAVAILABLE');}
 const reviewedAt=new Date().toISOString(),prepared=registry?historyAccountReviews(registry,pending,reviewedAt):{reviews:[],unresolved:pending};
 const reviews=new Map(prepared.reviews.map(r=>[r.accounts[0]!.accountId,r]));
 for(const accountId of pending){await check();
  // A conflicting numeric identity is never overwritten, even by a fresh profile.
  const resolution=resolveIdentity(await readAccountEvidence(db,[accountId]),accountId,null);
  if(resolution.status==='verified')continue;
  if(resolution.status==='conflict'){result.reasons.push('IDENTITY_CONFLICT');continue;}
  let review=reviews.get(accountId);
  if(!review&&provider.getPlayer&&result.profilesRequested<20)try{
   result.profilesRequested++;const o=await source(db,provider,'player:'+accountId);
   review=prepareCurrentProfile({schemaVersion:1,mode:'current_profile_capture',accountId,observation:{...o,source:{...o.source,provider:'opendota',knownAt:null}}},sha(JSON.stringify(o)),{accountIds:[accountId],reviewedAt:new Date().toISOString()}).review;
  }catch{result.reasons.push('PROFILE_UNAVAILABLE');}
  if(!review)continue;
  try{await check();const plan=await provision.preview(review);if(plan.status==='blocked'){result.reasons.push('IDENTITY_CONFLICT');continue;}
   await check();const applied=await provision.apply(review,plan.fingerprint);if(applied.accountProofsAdded>0)result.accountsVerified++;
   record({kind:'numeric_identity',review,planFingerprint:plan.fingerprint,observedAt:applied.observedAt,playersCreated:applied.playersCreated,proofsAdded:applied.accountProofsAdded});
  }catch(e){if(e instanceof Error&&e.message==='player_history_stale_attempt')throw e;result.reasons.push('IDENTITY_PROVISION_BLOCKED');}
 }
 const final=await readAccountEvidence(db,accounts);result.unresolvedAccounts=accounts.filter(id=>resolveIdentity(final,id,null).status!=='verified');
 if(result.unresolvedAccounts.length)result.reasons.push('UNRESOLVED_PARTICIPANTS');
 if(missing.length>100||prepared.unresolved.length>20)result.reasons.push('ENRICHMENT_BOUND_REACHED');
 const series=new SeriesProvisionRepository(db);
 for(const id of [...new Set(seriesIds)].sort(numeric)){await check();try{
  const request={providerSeriesIds:[id],snapshotAt:new Date().toISOString()},plan=await series.preview(request);
  if(plan.status==='blocked'){result.seriesBlocked.push(id);continue;}
  if(plan.groups.every(g=>g.existingSeriesId!==null))continue;
  await check();const applied=await series.apply(request,plan.fingerprint);result.seriesCreated+=applied.created;
  record({kind:'source_series',request,planFingerprint:plan.fingerprint,mappings:applied.mappings});
 }catch(e){if(e instanceof Error&&e.message==='player_history_stale_attempt')throw e;result.seriesBlocked.push(id);}}
 if(result.seriesBlocked.length)result.reasons.push('SERIES_PROVISION_BLOCKED');
 result.reasons=[...new Set(result.reasons)];result.status=result.reasons.length?'partial':'completed';return HistoryEnrichmentSchema.parse(result);
}
/** Existing frozen runtime path; the diagnostic roster is an actual historical map, never persisted. */
export async function historyReadiness(db:Db,bindings:PlayerHistoryBinding[],result:HistoryEnrichment){
 try{const snapshotAt=new Date().toISOString(),code=await readV1RuntimeCode();
  const inventory=await new V1DataRepository(db).exportReleaseInventory({fromAt:'2024-01-01T00:00:00.000Z',toAt:snapshotAt,snapshotAt,maxMaps:5000},code.code);
  const {history}=prepareReleaseHistory(inventory),map=history.maps[0];let used=new Set<string>();
  if(map){const diagnostic=createV1FeatureBuilder(history)({schemaVersion:1,cutoffAtUs:history.snapshotAtUs,targetMatchId:null,teamA:map.teamA,teamB:map.teamB,
   lineup:{basis:'actual_lineup_reconstructed',source:'verified-map-receipt:'+map.outcomeReceiptId,selectedAtUs:map.fetchedAtUs,revision:history.sourceFingerprint}});used=new Set(diagnostic.history.usedMatchIds);}
  result.players=bindings.map(p=>({...p,rawMaps:inventory.source.candidates.filter(m=>m.isPro===true&&m.radiantWin!==null&&m.endedAtUs!==null&&BigInt(m.endedAtUs)<BigInt(history.snapshotAtUs)&&m.players.some(x=>x.sourceAccountId===p.accountId)).length,
   eligibleMaps:history.maps.filter(m=>used.has(m.matchId)&&[...m.teamA,...m.teamB].some(x=>x.playerId===p.playerId&&x.accountId===p.accountId)).length}));result.assessedAt=snapshotAt;
  if(result.players.some(p=>p.eligibleMaps<5))result.reasons.push('INSUFFICIENT_PLAYER_HISTORY');
 }catch{result.reasons.push('HISTORY_READINESS_UNAVAILABLE');}
 result.reasons=[...new Set(result.reasons)];if(result.reasons.length)result.status='partial';return HistoryEnrichmentSchema.parse(result);
}
