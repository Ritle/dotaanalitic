import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {Steam32Schema} from '@dota/contracts';
import {archiveDigest,archiveStampAt} from './archive-evidence.js';
import type {TournamentArchiveSnapshot} from './tournament-evidence.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(id=>BigInt(id)<=9223372036854775807n);
const RawId=z.union([z.number().int().positive().safe(),Id]).transform(String).pipe(Id);
const Account=RawId.pipe(Steam32Schema);
const Seconds=z.number().int().nonnegative().max(253402300799).nullable();
const Team=z.object({team_id:RawId,members:z.array(z.object({account_id:Account,pro_name:z.string().max(120).nullish(),
  time_joined:Seconds.optional()})).max(100),registered_member_account_ids:z.array(Account).max(100).nullish()});
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const compare=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export function teamAccountOriginal(teamId:string){
  Id.parse(teamId);return `https://www.dota2.com/webapi/IDOTA2Teams/GetSingleTeamInfo/v001?team_id=${teamId}&get_dpc_info=true`;
}
/** Source account/alias associations only. A canonical-person merge requires separate reviewed evidence. */
export function verifyArchivedTeamAccounts(snapshot:TournamentArchiveSnapshot,teamId:string){
  const original=teamAccountOriginal(teamId),capturedAt=archiveStampAt(snapshot.timestamp);Time.parse(snapshot.fetchedAt);
  if(snapshot.original!==original||snapshot.originalLink!==original||new Date(snapshot.mementoDatetime).toISOString()!==capturedAt||
    capturedAt>snapshot.fetchedAt)throw new Error('team_archive_origin_or_time_mismatch');
  if(!/^[A-Z2-7]{32}$/.test(snapshot.digest)||archiveDigest(snapshot.bytes)!==snapshot.digest)throw new Error('team_archive_digest_mismatch');
  if(snapshot.bytes.byteLength>2*1024*1024)throw new Error('team_archive_too_large');
  const bytes=snapshot.encoding==='gzip'?gunzipSync(snapshot.bytes,{maxOutputLength:4*1024*1024}):
    snapshot.encoding==='identity'?Buffer.from(snapshot.bytes):null;
  if(bytes===null||bytes.byteLength>4*1024*1024)throw new Error('team_archive_encoding_or_size');
  const team=Team.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  if(team.team_id!==teamId)throw new Error('team_archive_id_mismatch');
  const ids=new Set(team.members.map(m=>m.account_id)),registered=team.registered_member_account_ids??null;
  if(ids.size!==team.members.length||registered!==null&&(new Set(registered).size!==registered.length||registered.some(id=>!ids.has(id))))
    throw new Error('team_archive_membership_conflict');
  const members=team.members.map(m=>({accountId:m.account_id,alias:m.pro_name?.trim()||null,
    sourceJoinedAt:m.time_joined?new Date(m.time_joined*1000).toISOString():null,
    registered:registered===null?null:registered.includes(m.account_id),canonicalPlayerId:null})).sort((a,b)=>compare(a.accountId,b.accountId));
  if(members.some(m=>m.sourceJoinedAt!==null&&m.sourceJoinedAt>capturedAt))throw new Error('team_archive_join_clock_conflict');
  return {policyVersion:'archived-steam32-associations-v1',status:'verified_archived_accounts' as const,
    scope:'source_account_alias_associations_only' as const,accountNamespace:'steam32' as const,teamId,
    sourceUrl:original,capturedAt,knownByAt:capturedAt,fetchedAt:snapshot.fetchedAt,
    members,registeredAccountIds:registered===null?null:[...registered].sort(compare),
    payloadSha256:hash(snapshot.bytes),decodedSha256:hash(bytes),cdxDigest:snapshot.digest,
    projectionSha256:hash(JSON.stringify({teamId,members,registeredAccountIds:registered===null?null:[...registered].sort(compare)})),
    sourceJoinedAtIsKnownAt:false,canonicalPlayersCreated:0,verifiedMapLineups:0,
    roles:null,autoIdentityMergeEligible:false,trainingReady:false,deployable:false};
}
export const MapAccountObservationSchema=z.object({schemaVersion:z.literal(1),mode:z.literal('live_opendota_map_account_observation'),
  matchId:Id,leagueId:Id,startedAt:Time,fetchedAt:Time,knownAt:z.null(),
  players:z.array(z.object({playerSlot:z.number().int().refine(n=>n>=0&&n<=4||n>=128&&n<=132),accountId:Steam32Schema.nullable()})).max(10),
  source:z.object({endpoint:z.string().max(200),payloadSha256:Sha,adapterVersion:z.string().max(100)})});

/** Counts evidence for account IDs, including across organizations. Never joins names or transfers an old roster. */
export function auditHistoricalMapAccounts(proofs:readonly ReturnType<typeof verifyArchivedTeamAccounts>[],input:unknown,snapshotAt:string){
  Time.parse(snapshotAt);const map=MapAccountObservationSchema.parse(input);
  if(map.startedAt>=map.fetchedAt||map.fetchedAt>snapshotAt)throw new Error('map_observation_clock_conflict');
  if(map.source.endpoint!==`/matches/${map.matchId}`)throw new Error('map_observation_endpoint_mismatch');
  const knownIds=map.players.flatMap(p=>p.accountId===null?[]:[p.accountId]);
  if(new Set(map.players.map(p=>p.playerSlot)).size!==map.players.length||new Set(knownIds).size!==knownIds.length)
    throw new Error('map_observation_duplicate_slot_or_account');
  if(proofs.length>50)throw new Error('account_proof_limit');
  const usable=new Map<string,typeof proofs[number]>();
  for(const proof of proofs){
    Time.parse(proof.knownByAt);Time.parse(proof.fetchedAt);Sha.parse(proof.payloadSha256);
    if(proof.status!=='verified_archived_accounts'||proof.accountNamespace!=='steam32'||proof.knownByAt>proof.fetchedAt)
      throw new Error('account_proof_invalid');
    if(proof.knownByAt<map.startedAt&&proof.fetchedAt<=snapshotAt)
      usable.set(`${proof.sourceUrl}:${proof.knownByAt}:${proof.payloadSha256}`,proof);
  }
  const ordered=[...usable.values()].sort((a,b)=>a.sourceUrl.localeCompare(b.sourceUrl)||a.knownByAt.localeCompare(b.knownByAt));
  const players=[...map.players].sort((a,b)=>a.playerSlot-b.playerSlot).map(player=>{
    const found=player.accountId===null?[]:ordered.filter(p=>p.members.some(m=>m.accountId===player.accountId));
    return {...player,accountEvidenceStatus:player.accountId===null?'unknown_account':found.length?'observed_before_cutoff':'no_matching_archive',
      earliestProvenByAt:found.length?found.map(p=>p.knownByAt).sort()[0]!:null,
      sourceTeamIds:[...new Set(found.map(p=>p.teamId))].sort(compare),
      proofPayloadHashes:[...new Set(found.map(p=>p.payloadSha256))].sort(),canonicalPlayerId:null};
  });
  const result={policyVersion:'historical-account-coverage-v1',scope:'account_id_evidence_not_lineup' as const,
    matchId:map.matchId,startedAt:map.startedAt,snapshotAt,mapObservationSha256:map.source.payloadSha256,
    mapCount:1,observedPlayerRows:players.length,knownMapAccounts:knownIds.length,
    accountsObservedBeforeCutoff:players.filter(p=>p.accountEvidenceStatus==='observed_before_cutoff').length,
    accountsWithoutMatchingArchive:players.filter(p=>p.accountEvidenceStatus==='no_matching_archive').length,
    unknownAccountRows:players.filter(p=>p.accountEvidenceStatus==='unknown_account').length,
    eligibleProofs:ordered.length,players,canonicalPlayersCreated:0,verifiedMapLineups:0,trainingExamples:0,
    strictDatasetStatus:'unavailable' as const,trainingReady:false,deployable:false};
  return {...result,fingerprint:hash(JSON.stringify(result))};
}
