import {z} from 'zod';
import type {ValvePatchClient} from './patch-client.js';
type List=Awaited<ReturnType<ValvePatchClient['getPatchList']>>;
type Notes=Awaited<ReturnType<ValvePatchClient['getPatchNotes']>>;
type News=Awaited<ReturnType<ValvePatchClient['getAnnouncements']>>;
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
/** Facts from primary endpoints, not reviewed release/availability evidence. No text classifier. */
export function comparePatchSources(label:string,list:List,notes:Notes,news:News){
  const patch=list.data.patches.find(p=>p.patch_number===label);
  if(!patch||notes.data.patch_number!==label)throw new Error('patch_source_mismatch');
  const token=new RegExp('(^|[^a-zA-Z0-9.])'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|[^a-zA-Z0-9.])');
  const announcements=news.data.appnews.newsitems.filter(n=>n.feedname==='steam_community_announcements'&&token.test(n.title))
    .sort((a,b)=>a.date-b.date||(BigInt(a.gid)<BigInt(b.gid)?-1:1));
  const reasons=['PUBLICATION_TIMESTAMP_IS_NOT_VERIFIED_EFFECTIVE_TIME','HISTORICAL_KNOWN_AT_UNPROVEN','HERO_IMPACT_REQUIRES_REVIEW','HERO_AVAILABILITY_UNASSESSED','RELEASE_COVERAGE_UNPROVEN'];
  if(patch.patch_timestamp!==notes.data.patch_timestamp)reasons.push('LIST_NOTES_TIMESTAMP_DISAGREEMENT');
  if(!announcements.length)reasons.push('ANNOUNCEMENT_NOT_FOUND_IN_BOUNDED_PAGE');
  if(announcements.some(n=>n.date!==patch.patch_timestamp))reasons.push('FEED_ANNOUNCEMENT_TIMESTAMP_DISAGREEMENT');
  if(announcements.length>1)reasons.push('MULTIPLE_ANNOUNCEMENT_CANDIDATES');
  const times=[patch.patch_timestamp,notes.data.patch_timestamp,...announcements.map(n=>n.date)];
  return {patchLabel:label,status:'requires_manual_review',datafeed:{listTimestamp:patch.patch_timestamp,listAt:iso(patch.patch_timestamp),
    notesTimestamp:notes.data.patch_timestamp,notesAt:iso(notes.data.patch_timestamp)},
    announcementCandidates:announcements.map(n=>({gid:n.gid,title:n.title,publishedAt:iso(n.date),sourceUrl:news.source.url})),
    timestampSpreadSeconds:Math.max(...times)-Math.min(...times),
    firstAnnouncementDeltaSeconds:announcements.length?announcements[0]!.date-patch.patch_timestamp:null,
    heroNotes:notes.data.heroes.map(h=>({heroId:h.hero_id,directNotes:h.hero_notes?.length??null,
      abilityNotes:h.abilities===undefined||h.abilities.some(a=>a.ability_notes===undefined)?null:h.abilities.reduce((sum,a)=>sum+a.ability_notes!.length,0),impactLevel:null,availability:null})),
    verifiedReleasedAt:null,coverageUntil:null,knownAt:null,autoRegistryEligible:false,
    reasons,sourceEvidence:[list.source,notes.source,news.source]};
}
const Capture=z.object({schema_version:z.literal(3),mode:z.literal('live_opendota'),observations:z.array(z.object({match_id:z.string().regex(/^[1-9]\d{0,18}$/),
  started_at:z.iso.datetime({precision:3}).nullable(),flags:z.object({confirmed_pro:z.boolean().nullable()})})).max(50)});
/** Reuses audited map IDs once; feed interval is explicitly a nominal candidate, never a verified patch. */
export function assessAuditedMapPatches(captures:unknown[],list:List){
  const all=captures.flatMap(c=>Capture.parse(c).observations),byMap=new Map<string,typeof all>();
  for(const row of all){const rows=byMap.get(row.match_id)??[];rows.push(row);byMap.set(row.match_id,rows);}
  const patches=[...list.data.patches].sort((a,b)=>a.patch_timestamp-b.patch_timestamp||a.patch_number.localeCompare(b.patch_number));
  const maps=[...byMap].sort(([a],[b])=>BigInt(a)<BigInt(b)?-1:1).map(([matchId,rows])=>{
    const consistent=new Set(rows.map(r=>r.started_at)).size===1&&rows.every(r=>r.flags.confirmed_pro===true),startedAt=consistent?rows[0]!.started_at:null;
    const time=startedAt===null?null:Date.parse(startedAt)/1000;
    const earlier=patches.filter(p=>time!==null&&p.patch_timestamp<=time),latest=earlier.at(-1);
    const same=latest?earlier.filter(p=>p.patch_timestamp===latest.patch_timestamp):[];
    const next=latest?patches.find(p=>p.patch_timestamp>latest.patch_timestamp):null;
    const nominal=same.length===1&&next?latest!.patch_number:null;
    return {matchId,startedAt,observations:rows.length,nominalPatchCandidate:nominal,verifiedPatchId:null,historicalKnownAt:null,
      reasons:[!consistent?'CAPTURE_CONFLICT_OR_UNVERIFIED_PRO':time===null?'START_UNKNOWN':!next?'FEED_INTERVAL_OPEN_OR_UNKNOWN':same.length!==1?'FEED_BOUNDARY_AMBIGUOUS':'FEED_INTERVAL_NOT_EFFECTIVE_VERSION_PROOF']};
  });
  return {observations:all.length,uniqueMaps:maps.length,duplicateObservations:all.length-maps.length,verifiedPatchMaps:0,
    historicalAvailabilityAssessed:false,maps};
}
