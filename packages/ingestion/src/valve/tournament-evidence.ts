import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {archiveDigest,archiveStampAt} from './archive-evidence.js';

const Time=z.iso.datetime({precision:3}),Seconds=z.number().int().positive().max(253402300799);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(id=>BigInt(id)<=9223372036854775807n);
const original='https://www.dota2.com/esports/ti12';
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const Config=z.object({DOTA_APP_ID:z.literal(570),BASE_URL:z.literal('https://www.dota2.com/'),
  RENDER_TIMESTAMP:Seconds,DPC_DATA:z.string().max(512*1024)});
const Event=z.object({event:z.literal(21),event_name:z.literal('#dpc_event_ti12'),
  registration_period:z.literal(8),leagues:z.array(z.object({league_id:z.literal(15728)})).min(1).max(20),
  timestamp_drop_lock:Seconds,timestamp_add_lock:Seconds});
export type TournamentArchiveSnapshot={timestamp:string;original:string;digest:string;mementoDatetime:string;
  originalLink:string;encoding:string;bytes:Uint8Array;fetchedAt:string};

/** Narrow, reviewed TI12 source schema. Neither a tournament roster nor a specific map lineup. */
export function verifyArchivedTi12Metadata(snapshot:TournamentArchiveSnapshot){
  const capturedAt=archiveStampAt(snapshot.timestamp);Time.parse(snapshot.fetchedAt);
  if(snapshot.original!==original||snapshot.originalLink!==original||
    new Date(snapshot.mementoDatetime).toISOString()!==capturedAt||capturedAt>snapshot.fetchedAt)
    throw new Error('archive_origin_or_time_mismatch');
  if(!/^[A-Z2-7]{32}$/.test(snapshot.digest)||archiveDigest(snapshot.bytes)!==snapshot.digest)
    throw new Error('archive_payload_digest_mismatch');
  if(snapshot.bytes.byteLength>2*1024*1024)throw new Error('archive_response_too_large');
  const bytes=snapshot.encoding==='gzip'?gunzipSync(snapshot.bytes,{maxOutputLength:4*1024*1024}):
    snapshot.encoding==='identity'?Buffer.from(snapshot.bytes):null;
  if(bytes===null||bytes.byteLength>4*1024*1024)throw new Error('archive_encoding_or_size_invalid');
  const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes),attrs=[...html.matchAll(/\bdata-dota_react="([^"]*)"/g)];
  if(attrs.length!==1)throw new Error('tournament_config_missing_or_ambiguous');
  const text=attrs[0]![1]!.replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  const config=Config.parse(JSON.parse(text));
  const events=z.object({events:z.array(z.unknown()).max(200)}).parse(JSON.parse(config.DPC_DATA)).events;
  const selected=events.filter(e=>typeof e==='object'&&e!==null&&'event' in e&&e.event===21);
  if(selected.length!==1)throw new Error('tournament_event_missing_or_ambiguous');
  const event=Event.parse(selected[0]),iso=(value:number)=>new Date(value*1000).toISOString();
  const renderedAt=iso(config.RENDER_TIMESTAMP),dropAt=iso(event.timestamp_drop_lock),addAt=iso(event.timestamp_add_lock);
  if(renderedAt>capturedAt||dropAt>addAt||addAt>capturedAt)throw new Error('tournament_clock_conflict');
  return {policyVersion:'archived-ti12-metadata-v1',status:'verified_archived_metadata' as const,
    scope:'event_league_registration_metadata_only' as const,eventId:'21',leagueId:'15728',registrationPeriod:8,
    capturedAt,knownByAt:capturedAt,fetchedAt:snapshot.fetchedAt,renderedAt,
    announcedDropLockAt:dropAt,announcedAddLockAt:addAt,sourceUrl:original,
    cdxDigest:snapshot.digest,payloadSha256:hash(snapshot.bytes),decodedSha256:hash(bytes),
    metadataSha256:hash(JSON.stringify(event)),lineupKnownAt:null,accountLinksKnownAt:null,
    mapSidesKnownAt:null,patchReleaseKnownAt:null,draftKnownAt:null,
    autoRegistryEligible:false,trainingReady:false,deployable:false};
}

/** These are present-day map-to-league references; the archive does NOT prove a map was scheduled then. */
export function ti12EvidenceCoverage(proof:ReturnType<typeof verifyArchivedTi12Metadata>,input:unknown){
  const report=z.object({schema_version:z.literal(3),mode:z.literal('live_opendota'),generated_at:Time,
    observations:z.array(z.object({match_id:Id,started_at:Time.nullable(),league_id:Id.nullable(),
      flags:z.object({confirmed_pro:z.boolean().nullable()})})).max(50)}).parse(input);
  if(report.generated_at>proof.fetchedAt)throw new Error('cohort_capture_after_audit_horizon');
  const grouped=new Map<string,typeof report.observations>();
  for(const row of report.observations)grouped.set(row.match_id,[...(grouped.get(row.match_id)??[]),row]);
  const maps=[...grouped].sort(([a],[b])=>BigInt(a)<BigInt(b)?-1:1).map(([matchId,rows])=>{
    const row=rows[0]!,conflict=rows.some(other=>JSON.stringify(other)!==JSON.stringify(row));
    const matching=!conflict&&row.started_at!==null&&row.started_at>proof.knownByAt&&row.started_at<report.generated_at&&
      row.league_id===proof.leagueId&&row.flags.confirmed_pro===true;
    return {matchId,startedAt:conflict?null:row.started_at,sourceConflict:conflict,
      matchingArchivedLeagueReference:matching,strictContextStatus:'unavailable' as const,
      missingEvidence:['MAP_LINEUP_KNOWN_AT','CANONICAL_ACCOUNT_LINKS','MAP_SIDE_KNOWN_AT',
        'VERIFIED_PATCH_RELEASE_COVERAGE','VERIFIED_SERIES_MEMBERSHIP','POST_DRAFT_HERO_KNOWN_AT'],
      strictTrainingEligible:false};
  });
  return {observations:report.observations.length,uniqueMaps:maps.length,
    mapsWithMatchingLeagueReference:maps.filter(m=>m.matchingArchivedLeagueReference).length,maps,
    verifiedMapLineups:0,verifiedMapContexts:0,trainingExamples:0,trainingReady:false,deployable:false};
}
