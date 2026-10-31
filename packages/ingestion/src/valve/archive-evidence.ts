import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {eventProjection,extractArchivedSteamEvent,steamBodySha256,SteamEventSchema} from './steam-event.js';
export const archiveDigest=(bytes:Uint8Array)=>{
  const data=createHash('sha1').update(bytes).digest(),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let out='',bits=0,value=0;
  for(const b of data){value=(value<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=alphabet[(value>>>bits)&31];}value&=(1<<bits)-1;}
  if(bits)out+=alphabet[(value<<(5-bits))&31];return out;
};
export function archiveStampAt(stamp:string){
  if(!/^\d{14}$/.test(stamp))throw new Error('invalid_archive_timestamp');
  const iso=`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}.000Z`;
  z.iso.datetime({precision:3}).parse(iso);if(new Date(iso).toISOString()!==iso)throw new Error('invalid_archive_timestamp');return iso;
}
export function parseArchiveIndex(input:unknown,originalUrl:string,beforeAt:string){
  const rows=z.array(z.array(z.string()).length(3)).max(6).parse(input);if(!rows.length)return [];
  if(JSON.stringify(rows[0])!==JSON.stringify(['timestamp','original','digest']))throw new Error('invalid_archive_index_header');
  return rows.slice(1).map(([timestamp,original,digest])=>{
    const capturedAt=archiveStampAt(timestamp!);if(original!==originalUrl||capturedAt>=beforeAt||!/^[A-Z2-7]{32}$/.test(digest!))throw new Error('invalid_archive_index_record');
    return {timestamp:timestamp!,original:original!,digest:digest!,capturedAt};
  }).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
}
type Snapshot={timestamp:string;original:string;digest:string;mementoDatetime:string;originalLink:string;encoding:string;bytes:Uint8Array};
/** Cryptographic binding is to the exact CDX payload (sometimes gzip), not guessed decoded bytes. */
export function verifyArchivedAnnouncement(snapshot:Snapshot,eventId:string,liveInput:unknown){
  const expected=`https://store.steampowered.com/news/app/570/view/${eventId}`,capturedAt=archiveStampAt(snapshot.timestamp);
  if(snapshot.original!==expected||snapshot.originalLink!==expected||new Date(snapshot.mementoDatetime).toISOString()!==capturedAt)throw new Error('archive_origin_or_time_mismatch');
  if(!/^[A-Z2-7]{32}$/.test(snapshot.digest)||archiveDigest(snapshot.bytes)!==snapshot.digest)throw new Error('archive_payload_digest_mismatch');
  if(snapshot.bytes.byteLength>2*1024*1024)throw new Error('archive_response_too_large');
  const decoded=snapshot.encoding==='gzip'?gunzipSync(snapshot.bytes,{maxOutputLength:4*1024*1024}):snapshot.encoding==='identity'?Buffer.from(snapshot.bytes):null;
  if(decoded===null||decoded.byteLength>4*1024*1024)throw new Error('archive_encoding_or_size_invalid');
  const archived=extractArchivedSteamEvent(new TextDecoder('utf-8',{fatal:true}).decode(decoded),eventId),live=SteamEventSchema.parse(liveInput);
  if(live.gid!==eventId)throw new Error('live_event_id_mismatch');
  const old=eventProjection(archived),current=eventProjection(live),reasons:string[]=[];
  if(!old.published||old.hidden)reasons.push('ARCHIVED_EVENT_NOT_PUBLIC');
  if(old.bodyPostedAt===null||old.bodyModifiedAt===null||old.bodyModifiedAt<old.bodyPostedAt||old.bodyModifiedAt>capturedAt||old.bodyPostedAt>capturedAt)reasons.push('ARCHIVED_BODY_CLOCK_UNKNOWN_OR_CONFLICT');
  const sameBody=old.bodySha256===current.bodySha256;
  return {scope:'announcement_body_only' as const,status:reasons.length?'unavailable':'verified_archived_body',capturedAt,
    archived:old,current,sameBodyAsCurrent:sameBody,bodyKnownByAt:reasons.length?null:capturedAt,
    currentBodyKnownByAt:reasons.length||!sameBody?null:capturedAt,bodySha256:steamBodySha256(archived.announcement_body.body),
    payloadSha256:createHash('sha256').update(snapshot.bytes).digest('hex'),decodedSha256:createHash('sha256').update(decoded).digest('hex'),
    cdxDigest:snapshot.digest,reasons,verifiedReleasedAt:null,releaseCoverageUntil:null,heroNotesKnownAt:null,
    modelEligibility:'not_assessed',autoRegistryEligible:false,limitations:['ANNOUNCEMENT_BODY_ONLY','EXTERNAL_PATCH_NOTES_NOT_ARCHIVED_BY_LINK','NO_EXACT_DEPLOYMENT_TIME','NO_HERO_AVAILABILITY_OR_MATCH_OUTCOME_PROOF']};
}
export function archivedBodyCoverage(proof:ReturnType<typeof verifyArchivedAnnouncement>,input:unknown){
  const rows=z.array(z.object({match_id:z.string().regex(/^[1-9]\d{0,18}$/).refine(id=>BigInt(id)<=9223372036854775807n),
    started_at:z.iso.datetime({precision:3}).nullable(),flags:z.object({confirmed_pro:z.boolean().nullable()})})).max(50).parse(input);
  const grouped=new Map<string,typeof rows>();for(const r of rows){const group=grouped.get(r.match_id)??[];group.push(r);grouped.set(r.match_id,group);}
  const maps=[...grouped].map(([matchId,group])=>{
    const consistent=group.every(r=>r.flags.confirmed_pro===true)&&new Set(group.map(r=>r.started_at)).size===1,startedAt=consistent?group[0]!.started_at:null;
    const precedes=proof.bodyKnownByAt!==null&&startedAt!==null?proof.bodyKnownByAt<startedAt:null;
    return {matchId,startedAt,archiveProofPrecedesStart:precedes,announcementBodyAvailability:precedes?'verified_by_archive':'unproven',
      announcementBodyKnownByAt:precedes?proof.bodyKnownByAt:null,verifiedPatchId:null,heroNotesKnownAt:null,trainingEligible:false};
  });
  return {scope:'announcement_body_only',observations:rows.length,uniqueMaps:maps.length,sourceBodyVerifiedMaps:maps.filter(m=>m.archiveProofPrecedesStart===true).length,
    verifiedPatchMaps:0,trainingExamples:0,maps};
}
