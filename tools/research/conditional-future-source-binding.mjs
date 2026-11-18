/** Bind declared conditional inputs to separately pinned local source bytes. No network/DB/scoring. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {AccountEvidenceSchema} from '../../packages/contracts/dist/index.js';
import {resolveIdentity} from '../../packages/db/dist/identity.js';
import {parseSource,classifyLeague,completedObservation,sideOf} from '../../packages/ingestion/dist/quality.js';
import {ConditionalHoldoutInputSchema,buildConditionalFutureHoldout,conditionalDigest} from '../../.tools/s304-future-runtime/conditional-future-holdout.mjs';

export const sourceSha=bytes=>createHash('sha256').update(bytes).digest('hex');
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(x=>BigInt(x)<=9223372036854775807n),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Time=z.string().datetime({precision:3}),Text=z.string().min(1).max(512);
const Reference=z.object({rawBody:z.string().max(16000000),bodySha256:Sha,fetchedAt:Time}).strict();
const Receipt=Reference.extend({matchId:Id,receiptId:Id,kind:z.enum(['raw_http','stored_projection']),originalPayloadSha256:Sha,
 adapterVersion:Text,endpoint:Text}).strict();
export const ConditionalSourceArchiveSchema=z.object({format:z.literal('conditional-source-archive-v1'),syntheticOnly:z.boolean(),recordedAt:Time,
 provenance:z.object({kind:z.enum(['synthetic_fixture','pinned_local_export']),sourceSha256:Sha}).strict(),
 targetMapIds:z.array(Id).max(300),historyMapIds:z.array(Id).max(5000),
 leagues:Reference,identities:z.array(AccountEvidenceSchema.safeExtend({observationId:Text})).max(100000),
 teams:z.array(z.object({nativeId:Id,canonicalId:Id}).strict()).max(20000),receipts:z.array(Receipt).max(5000)}).strict();
const us=t=>String(BigInt(Date.parse(t))*1000n),sortIds=ids=>[...ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
const eq=(a,b)=>conditionalDigest(a)===conditionalDigest(b);
const unique=(xs,reason)=>assert.equal(new Set(xs).size,xs.length,reason);
const League=z.object({leagueid:z.union([z.number().int().positive().safe(),Id]).transform(String),tier:z.string().nullable().optional()});
const sortedMembers=ps=>[...ps].sort((a,b)=>a.slot-b.slot);
const plain=ps=>ps.map(({playerId,accountId})=>({playerId,accountId})).sort((a,b)=>BigInt(a.playerId)<BigInt(b.playerId)?-1:1);

export function inspectConditionalSources(raw){
 const a=ConditionalSourceArchiveSchema.parse(raw),at=us(a.recordedAt);
 assert.equal(a.syntheticOnly,a.provenance.kind==='synthetic_fixture','synthetic_source_mismatch');
 assert.equal(sourceSha(a.leagues.rawBody),a.leagues.bodySha256,'league_bytes_changed');
 assert(a.leagues.fetchedAt<=a.recordedAt,'reference_after_snapshot');
 unique(a.receipts.map(r=>r.matchId),'duplicate_source_map');unique(a.receipts.map(r=>r.receiptId),'duplicate_source_receipt');
 unique(a.targetMapIds,'duplicate_target_scope');unique(a.historyMapIds,'duplicate_history_scope');
 unique(a.teams.map(t=>t.nativeId),'ambiguous_native_team');unique(a.teams.map(t=>t.canonicalId),'ambiguous_canonical_team');
 unique(a.identities.map(i=>i.observationId),'duplicate_identity_observation');
 assert(a.identities.every(i=>i.fetchedAt<=a.recordedAt&&(i.knownAt===null||i.knownAt<=a.recordedAt)),'identity_after_snapshot');
 const leagues=z.array(League).max(30000).parse(JSON.parse(a.leagues.rawBody));
 unique(leagues.map(l=>l.leagueid),'ambiguous_league_reference');
 const teams=new Map(a.teams.map(t=>[t.nativeId,t.canonicalId]));
 const rows=a.receipts.map(r=>{
  assert.equal(sourceSha(r.rawBody),r.bodySha256,'source_bytes_changed');
  if(r.kind==='raw_http')assert.equal(r.originalPayloadSha256,r.bodySha256,'raw_original_hash_mismatch');
  assert.equal(r.endpoint,'/matches/'+r.matchId,'source_endpoint_mismatch');assert(r.fetchedAt<=a.recordedAt,'source_after_snapshot');
  const parsed=parseSource({rawBody:r.rawBody,source:{provider:'opendota',adapterVersion:r.adapterVersion,endpoint:r.endpoint,
   fetchedAt:r.fetchedAt,knownAt:null,payloadSha256:r.bodySha256}},r.matchId);
  const m=parsed.match,reasons=[...parsed.issues];
  if(!m)return {matchId:r.matchId,reasons,receipt:r,target:null,history:null,heroHistory:null,label:null};
  if(classifyLeague(leagues.find(l=>l.leagueid===m.leagueid)?.tier)!==true)reasons.push('PRO_LEAGUE_NOT_ESTABLISHED');
  if(!m.start_time||!completedObservation(m,r.fetchedAt)||typeof m.radiant_win!=='boolean')reasons.push('COMPLETED_OUTCOME_NOT_ESTABLISHED');
  if(!m.series_id)reasons.push('NATIVE_SERIES_UNKNOWN');
  const radiantTeamId=teams.get(m.radiant_team_id),direTeamId=teams.get(m.dire_team_id);
  if(!radiantTeamId||!direTeamId||radiantTeamId===direTeamId)reasons.push('CANONICAL_TEAM_LINK_MISSING');
  const players=(m.players??[]).map(p=>{
   const identity=p.account_id?resolveIdentity(a.identities,p.account_id,null):null;
   const accounts=new Set(a.identities.filter(i=>i.playerId===identity?.playerId&&i.status==='verified').map(i=>i.externalAccountId));
   if(identity?.status!=='verified'||accounts.size!==1||p.account_id==='4294967295')reasons.push('PLAYER_IDENTITY_UNVERIFIED');
   return {slot:p.player_slot,accountId:p.account_id,playerId:identity?.playerId??null,heroId:p.hero_id&&p.hero_id>0?p.hero_id:null};
  });
  if(players.length!==10||new Set(players.map(p=>p.slot)).size!==10||players.some(p=>sideOf(p.slot)===null)||
   new Set(players.map(p=>p.accountId)).size!==10||new Set(players.map(p=>p.playerId)).size!==10)reasons.push('PLAYER_SLOTS_OR_IDENTITIES_INVALID');
  const heroes=players.flatMap(p=>p.heroId===null?[]:[p.heroId]);
  if(new Set(heroes).size!==heroes.length)reasons.push('DUPLICATE_FINAL_HERO');
  const base={matchId:r.matchId,reasons:[...new Set(reasons)].sort(),receipt:r};
  if(reasons.length)return {...base,target:null,history:null,heroHistory:null,label:null};
  const startedAtUs=String(BigInt(m.start_time)*1000000n),completedAtUs=String((BigInt(m.start_time)+BigInt(m.duration))*1000000n);
  const seriesKey=JSON.stringify(['opendota',m.series_id]),aRadiant=BigInt(radiantTeamId)<BigInt(direTeamId);
  const teamA=plain(players.filter(p=>(p.slot<128)===aRadiant)),teamB=plain(players.filter(p=>(p.slot<128)!==aRadiant));
  const target={matchId:r.matchId,seriesKey,eventId:m.leagueid,startedAtUs,isPro:true,radiantTeamId,direTeamId,
   canonicalPatchId:null,sourceSha256:r.originalPayloadSha256,knownAtUs:null,fetchedAtUs:us(r.fetchedAt),players:sortedMembers(players)};
  const history={matchId:r.matchId,seriesKey,startedAtUs,completedAtUs,isPro:true,teamA,teamB,teamAWon:aRadiant?m.radiant_win:!m.radiant_win,
   outcomeReceiptId:r.receiptId,payloadSha256:r.originalPayloadSha256,fetchedAtUs:us(r.fetchedAt),labelVerifiedAtUs:at,factClocks:[]};
  const heroHistory={matchId:r.matchId,startedAtUs,completedAtUs,fetchedAtUs:us(r.fetchedAt),knownAtUs:null,isPro:true,
   receiptSha256:r.originalPayloadSha256,canonicalPatchId:null,players:players.map(({slot,...p})=>p)};
  const label={matchId:r.matchId,seriesKey,eventId:m.leagueid,teamAWon:history.teamAWon,startedAtUs,completedAtUs,verifiedAtUs:at,
   receiptId:r.receiptId,payloadSha256:r.originalPayloadSha256,retainedBodySha256:r.bodySha256,receiptKind:r.kind,
   teamASide:aRadiant?'radiant':'dire',basis:'source_bound_completed_professional_map'};
  return {...base,target,history,heroHistory,label};
 });
 return {archive:a,rows};
}

/** Compare every consumed value with independently pinned sources; labels returned separately. */
export function bindConditionalFutureSources(rawInput,rawArchive){
 const input=ConditionalHoldoutInputSchema.parse(rawInput),{archive,rows:sourceRows}=inspectConditionalSources(rawArchive);
 for(const c of input.cases)if(c.history?.maps.some(m=>m.matchId===c.target.matchId)||c.heroHistory?.maps.some(m=>m.matchId===c.target.matchId))
  throw Error('target_outcome_forbidden');
 assert.equal(input.syntheticOnly,archive.syntheticOnly,'synthetic_input_mismatch');
 assert.deepEqual(sortIds(input.cases.map(c=>c.target.matchId)),sortIds(archive.targetMapIds),'target_source_universe_mismatch');
 const source=new Map(sourceRows.map(r=>[r.matchId,r])),ledger=[],labels=[];
 const bound=structuredClone(input),archiveFingerprint=conditionalDigest(archive),snapshot=us(archive.recordedAt);
 for(const c of bound.cases){
  const r=source.get(c.target.matchId),reasons=[];
  if(!r?.target)reasons.push(...r?.reasons??['TARGET_SOURCE_MISSING']);
  else{
   if(!eq({...c.target,players:sortedMembers(c.target.players)},r.target))reasons.push('TARGET_SOURCE_MISMATCH');
   if(!reasons.length&&r.label)labels.push(r.label);
  }
  for(const [name,kind] of [['history','history'],['heroHistory','heroHistory']]){
   const h=c[name];if(!h){reasons.push('HISTORY_INPUT_MISSING');continue;}
   if(!eq(sortIds(h.maps.map(m=>m.matchId)),sortIds(archive.historyMapIds.filter(id=>id!==c.target.matchId))))reasons.push('HISTORY_UNIVERSE_MISMATCH');
   if(h.snapshotAtUs!==snapshot||(name==='history'?h.sourceFingerprint:h.sourceSha256)!==archiveFingerprint)reasons.push('HISTORY_ARCHIVE_BINDING_MISMATCH');
   if(name==='history'&&!eq([...h.identities].sort((a,b)=>a.observationId.localeCompare(b.observationId)),[...archive.identities].sort((a,b)=>a.observationId.localeCompare(b.observationId))))reasons.push('IDENTITY_ARCHIVE_MISMATCH');
   for(const m of h.maps){
    const s=source.get(m.matchId),expected=s?.[kind];
    if(!expected){reasons.push('HISTORY_SOURCE_MISSING_OR_INVALID');continue;}
    const normalize=x=>name==='history'?{...x,teamA:plain(x.teamA),teamB:plain(x.teamB)}:
     {...x,players:[...x.players].sort((a,b)=>BigInt(a.playerId)<BigInt(b.playerId)?-1:1)};
    if(!eq(normalize(m),normalize(expected)))reasons.push('HISTORY_SOURCE_MISMATCH');
   }
  }
  const uniqueReasons=[...new Set(reasons)].sort();
  ledger.push({matchId:c.target.matchId,status:uniqueReasons.length?'unavailable':'source_bound',reasons:uniqueReasons,
   targetReceipt:r?{receiptId:r.receipt.receiptId,kind:r.receipt.kind,retainedBodySha256:r.receipt.bodySha256,originalPayloadSha256:r.receipt.originalPayloadSha256}:null});
  if(uniqueReasons.length){c.history=null;c.heroHistory=null;}
 }
 // Source errors remove inputs, never the target from the denominator. Existing series closure applies.
 const features=buildConditionalFutureHoldout(bound);
 const sourceLedger={format:'conditional-source-binding-ledger-v1',syntheticOnly:archive.syntheticOnly,archiveFingerprint,
  rows:ledger.sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1),sourceMaps:sourceRows.length,
  retainedRawResponses:sourceRows.filter(r=>r.receipt.kind==='raw_http').length,
  retainedProjections:sourceRows.filter(r=>r.receipt.kind==='stored_projection').length,
  remoteInventoryComplete:false,eventEditionScopeVerified:false,registrationAllowed:false,deployable:false};
 return {features,labels:{format:'conditional-verified-labels-v1',syntheticOnly:archive.syntheticOnly,archiveFingerprint,
  rows:labels.sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1),trainingPerformed:false,deployable:false},sourceLedger};
}
