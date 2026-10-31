import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {AccountEvidenceSchema,Steam32Schema} from '@dota/contracts';
import {resolveIdentity} from '@dota/db';
import {archiveDigest,archiveStampAt} from '../valve/archive-evidence.js';
import {steam64FromAccount} from '../valve/steam-profile-evidence.js';
import {auditHistoricalMapAccounts} from '../valve/team-account-evidence.js';
import type {TournamentArchiveSnapshot} from '../valve/tournament-evidence.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Revision=z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(v=>BigInt(v)<=9223372036854775807n);
const RawId=z.union([z.number().int().nonnegative().safe(),z.string().regex(/^(0|[1-9]\d{0,18})$/)]).transform(String);
const Account=RawId.pipe(Steam32Schema),Targets=z.array(Steam32Schema).min(1).max(10).refine(a=>new Set(a).size===a.length);
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const compare=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export const PRO_REGISTRY_ORIGINAL='https://api.opendota.com/api/proPlayers';
export function validateProRegistryOriginal(url:string){
  if(url!==PRO_REGISTRY_ORIGINAL&&url!==PRO_REGISTRY_ORIGINAL+'?')throw new Error('pro_registry_url_mismatch');return url;
}
export function parseProRegistryArchiveIndex(input:unknown,_original:string,beforeAt:string){
  validateProRegistryOriginal(_original);Time.parse(beforeAt);
  const rows=z.array(z.array(z.string()).length(3)).max(6).parse(input);if(!rows.length)return [];
  if(JSON.stringify(rows[0])!==JSON.stringify(['timestamp','original','digest']))throw new Error('pro_registry_index_header');
  return rows.slice(1).map(([timestamp,original,digest])=>{
    validateProRegistryOriginal(original!);const capturedAt=archiveStampAt(timestamp!);
    if(capturedAt>=beforeAt||!/^[A-Z2-7]{32}$/.test(digest!))throw new Error('pro_registry_index_record');
    return {timestamp:timestamp!,original:original!,digest:digest!,capturedAt};
  }).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
}
const SourceMember=z.object({account_id:Account,steamid:z.string().regex(/^\d{17}$/).nullish(),name:z.string().max(120).nullish(),
  team_id:RawId.transform(id=>id==='0'?null:id).pipe(Id.nullable()).nullish(),is_pro:z.boolean().nullish(),is_locked:z.boolean().nullish()});
const Member=z.object({accountId:Steam32Schema,steam64:z.string().regex(/^\d{17}$/).nullable(),alias:z.string().max(120).nullable(),
  reportedTeamId:Id.nullable(),reportedPro:z.boolean().nullable(),reportedLocked:z.boolean().nullable()});
/** Only the requested accounts are projected; provider flags never become canonical links or map-level pro/lineup facts. */
export function verifyArchivedProRegistry(snapshot:TournamentArchiveSnapshot,accountIds:readonly string[]){
  const requestedAccountIds=Targets.parse(accountIds).sort(compare);validateProRegistryOriginal(snapshot.original);
  const capturedAt=archiveStampAt(snapshot.timestamp);Time.parse(snapshot.fetchedAt);
  if(snapshot.originalLink!==snapshot.original||new Date(snapshot.mementoDatetime).toISOString()!==capturedAt||capturedAt>snapshot.fetchedAt)
    throw new Error('pro_registry_origin_or_time');
  if(snapshot.bytes.byteLength>2*1024*1024||!/^[A-Z2-7]{32}$/.test(snapshot.digest)||archiveDigest(snapshot.bytes)!==snapshot.digest)
    throw new Error('pro_registry_size_or_digest');
  const bytes=snapshot.encoding==='gzip'?gunzipSync(snapshot.bytes,{maxOutputLength:4*1024*1024}):
    snapshot.encoding==='identity'?Buffer.from(snapshot.bytes):null;
  if(bytes===null||bytes.byteLength>4*1024*1024)throw new Error('pro_registry_encoding_or_size');
  const rows=z.array(z.unknown()).max(10000).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  const indexed=rows.map(row=>({accountId:z.object({account_id:Account}).parse(row).account_id,row}));
  if(new Set(indexed.map(r=>r.accountId)).size!==indexed.length)throw new Error('pro_registry_duplicate_accounts');
  const targets=new Set(requestedAccountIds),members=indexed.filter(r=>targets.has(r.accountId)).map(({row})=>{
    const p=SourceMember.parse(row);
    if(p.steamid!=null&&p.steamid!==steam64FromAccount(p.account_id))throw new Error('pro_registry_steamid_conflict');
    return {accountId:p.account_id,steam64:p.steamid??null,alias:p.name?.trim()||null,reportedTeamId:p.team_id??null,
      reportedPro:p.is_pro??null,reportedLocked:p.is_locked??null};
  }).sort((a,b)=>compare(a.accountId,b.accountId));
  return {policyVersion:'archived-pro-registry-v1',status:'verified_archived_registry' as const,scope:'provider_notable_account_registry' as const,
    sourceUrl:snapshot.original,capturedAt,knownByAt:capturedAt,fetchedAt:snapshot.fetchedAt,sourceRowCount:rows.length,
    requestedAccountIds,members,missingAccountIds:requestedAccountIds.filter(id=>!members.some(m=>m.accountId===id)),
    payloadSha256:hash(snapshot.bytes),decodedSha256:hash(bytes),cdxDigest:snapshot.digest,
    projectionSha256:hash(JSON.stringify({requestedAccountIds,members})),canonicalPlayersCreated:0,autoIdentityMergeEligible:false,
    verifiedMapLineups:0,trainingExamples:0,trainingReady:false,deployable:false};
}
const RegistryProof=z.object({status:z.literal('verified_archived_registry'),scope:z.literal('provider_notable_account_registry'),
  sourceUrl:z.string(),knownByAt:Time,fetchedAt:Time,payloadSha256:Sha,requestedAccountIds:Targets,members:z.array(Member).max(10),projectionSha256:Sha});
export const IdentityLedgerSnapshotSchema=z.object({schemaVersion:z.literal(1),mode:z.literal('read_only_identity_ledger_snapshot'),
  observedAt:Time,registryRevision:Revision,accountIds:Targets,
  observations:z.array(z.object({observationId:z.string().min(1).max(100),claim:AccountEvidenceSchema})).max(10000),
  referencesRedactedToSha256:z.literal(true)});
/** The existing resolver remains the authority. Registry observations cannot synthesize verified ledger claims. */
export function assessRegistryIdentityEvidence(proofInput:unknown,map:unknown,ledgerInput:unknown,snapshotAt:string){
  const base=auditHistoricalMapAccounts([],map,snapshotAt),proof=RegistryProof.parse(proofInput),ledger=IdentityLedgerSnapshotSchema.parse(ledgerInput);
  const observations=ledger.observations.map(({observationId,claim})=>({observationId,...claim}));
  validateProRegistryOriginal(proof.sourceUrl);
  if(proof.knownByAt>proof.fetchedAt||proof.fetchedAt>snapshotAt||ledger.observedAt>snapshotAt)throw new Error('identity_review_clock');
  const requested=[...proof.requestedAccountIds].sort(compare),members=[...proof.members].sort((a,b)=>compare(a.accountId,b.accountId));
  if(new Set(members.map(m=>m.accountId)).size!==members.length||members.some(m=>!requested.includes(m.accountId)||
    m.steam64!==null&&m.steam64!==steam64FromAccount(m.accountId))||
    proof.projectionSha256!==hash(JSON.stringify({requestedAccountIds:requested,members})))throw new Error('identity_review_projection');
  const knownIds=base.players.flatMap(p=>p.accountId===null?[]:[p.accountId]).sort(compare);
  if(JSON.stringify([...ledger.accountIds].sort(compare))!==JSON.stringify(knownIds)||JSON.stringify(requested)!==JSON.stringify(knownIds))
    throw new Error('identity_review_account_selection');
  if(new Set(observations.map(r=>r.observationId)).size!==observations.length||
    observations.some(r=>!knownIds.includes(r.externalAccountId)||r.fetchedAt>ledger.observedAt))throw new Error('identity_review_ledger_scope');
  const available=proof.knownByAt<base.startedAt;
  const players=base.players.map(p=>{
    const source=available?members.find(m=>m.accountId===p.accountId):undefined;
    const resolution=p.accountId===null?null:resolveIdentity(observations,p.accountId,base.startedAt);
    return {playerSlot:p.playerSlot,accountId:p.accountId,registryObservedBeforeCutoff:source!==undefined,
      registryAlias:source?.alias??null,reportedTeamId:source?.reportedTeamId??null,reportedPro:source?.reportedPro??null,
      reportedLocked:source?.reportedLocked??null,canonicalPlayerId:resolution?.playerId??null,
      canonicalStatus:resolution?.status??'unknown',observationIds:resolution?.observationIds??[],duplicateCanonicalPlayer:false};
  });
  for(const p of players)p.duplicateCanonicalPlayer=p.canonicalPlayerId!==null&&players.filter(v=>v.canonicalPlayerId===p.canonicalPlayerId).length>1;
  const result={policyVersion:'registry-identity-suitability-v1',scope:'source_account_and_existing_ledger_review_only' as const,
    snapshotAt,matchId:base.matchId,startedAt:base.startedAt,mapCount:1,knownMapAccounts:knownIds.length,unknownAccountRows:base.unknownAccountRows,
    registryObservedAccounts:players.filter(p=>p.registryObservedBeforeCutoff).length,
    registryReportedProAccounts:players.filter(p=>p.reportedPro===true).length,
    canonicalVerifiedAccounts:players.filter(p=>p.canonicalStatus==='verified'&&!p.duplicateCanonicalPlayer).length,
    canonicalConflictingAccounts:players.filter(p=>p.canonicalStatus==='conflict').length,
    duplicateCanonicalAccounts:players.filter(p=>p.duplicateCanonicalPlayer).length,
    accountsRequiringLinkReview:players.filter(p=>p.accountId!==null&&(p.canonicalStatus!=='verified'||p.duplicateCanonicalPlayer)).length,
    registryPayloadSha256:proof.payloadSha256,ledgerObservedAt:ledger.observedAt,ledgerRevision:ledger.registryRevision,players,
    canonicalPlayersCreated:0,verifiedMapLineups:0,trainingExamples:0,strictDatasetStatus:'unavailable' as const,
    remainingGates:['MAP_SPECIFIC_LINEUP_KNOWN_AT','MAP_SIDE_SERIES_PATCH_EVIDENCE','MULTI_SERIES_FROZEN_COHORT'],trainingReady:false,deployable:false};
  return {...result,fingerprint:hash(JSON.stringify(result))};
}
