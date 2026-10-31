import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {archiveDigest,archiveStampAt} from './archive-evidence.js';
import type {TournamentArchiveSnapshot} from './tournament-evidence.js';
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(id=>BigInt(id)<=9223372036854775807n);
const Rows=z.array(z.object({nickname:z.string().trim().min(1).max(100),
  confirmation_time:z.number().int().positive().max(253402300799).nullable()})).max(100);
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
/** Public registered nicknames only. Nicknames do not link canonical identities or prove a map's actual five. */
export function verifyArchivedTeamRegistration(snapshot:TournamentArchiveSnapshot,teamId:string){
  Id.parse(teamId);z.iso.datetime({precision:3}).parse(snapshot.fetchedAt);
  const original=`https://www.dota2.com/majorsregistration/teammembers?team_id=${teamId}`,
    capturedAt=archiveStampAt(snapshot.timestamp);
  if(snapshot.original!==original||snapshot.originalLink!==original||
    new Date(snapshot.mementoDatetime).toISOString()!==capturedAt||capturedAt>snapshot.fetchedAt)
    throw new Error('registration_archive_origin_or_time_mismatch');
  if(!/^[A-Z2-7]{32}$/.test(snapshot.digest)||archiveDigest(snapshot.bytes)!==snapshot.digest)
    throw new Error('registration_archive_digest_mismatch');
  if(snapshot.bytes.byteLength>2*1024*1024)throw new Error('registration_archive_too_large');
  const bytes=snapshot.encoding==='gzip'?gunzipSync(snapshot.bytes,{maxOutputLength:4*1024*1024}):
    snapshot.encoding==='identity'?Buffer.from(snapshot.bytes):null;
  if(bytes===null||bytes.byteLength>4*1024*1024)throw new Error('registration_archive_encoding_or_size');
  const rows=Rows.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  const entries=rows.map(row=>({nickname:row.nickname,
    sourceConfirmationAt:row.confirmation_time===null?null:new Date(row.confirmation_time*1000).toISOString(),
    canonicalPlayerId:null,externalAccountId:null}));
  if(entries.some(row=>row.sourceConfirmationAt!==null&&row.sourceConfirmationAt>capturedAt))
    throw new Error('registration_source_clock_conflict');
  return {policyVersion:'archived-registration-nicknames-v1',status:'verified_archived_response' as const,
    scope:'registered_nicknames_for_organization_only' as const,teamId,sourceUrl:original,
    capturedAt,knownByAt:capturedAt,fetchedAt:snapshot.fetchedAt,registeredRows:entries.length,
    distinctNicknames:new Set(entries.map(row=>row.nickname)).size,entries,
    cdxDigest:snapshot.digest,payloadSha256:hash(snapshot.bytes),decodedSha256:hash(bytes),
    projectionSha256:hash(JSON.stringify(entries)),verifiedCanonicalPlayers:0,verifiedMapLineups:0,
    mapId:null,mapSide:null,roles:null,sourceConfirmationIsKnownAt:false,
    autoIdentityMergeEligible:false,trainingReady:false,deployable:false};
}
