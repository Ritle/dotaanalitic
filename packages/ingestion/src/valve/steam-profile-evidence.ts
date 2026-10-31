import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {Steam32Schema} from '@dota/contracts';
import {archiveDigest,archiveStampAt} from './archive-evidence.js';
import {auditHistoricalMapAccounts,verifyArchivedTeamAccounts} from './team-account-evidence.js';
import type {TournamentArchiveSnapshot} from './tournament-evidence.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const ProfileLookupPlanSchema=z.object({schemaVersion:z.literal(1),previousEvidence:z.object({
  file:z.literal('docs/evidence/s3-01-ti12-account-evidence.json'),sha256:Sha}),
  targets:z.array(z.object({accountId:Steam32Schema,original:z.string().max(300)})).min(1).max(4)
    .refine(rows=>new Set(rows.map(r=>r.accountId)).size===rows.length)});
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
// Public universe, individual account, default instance. All arithmetic remains bigint.
export function steam64FromAccount(accountId:string){Steam32Schema.parse(accountId);return ((1n<<56n)|(1n<<52n)|(1n<<32n)|BigInt(accountId)).toString();}
export function steamProfileOriginal(accountId:string){return `https://steamcommunity.com/profiles/${steam64FromAccount(accountId)}/`;}
/** Only observed Steam profile forms; no URL normalization of encoded paths, credentials or dot segments. */
export function steamProfileLocation(original:string,accountId:string){
  const id=steam64FromAccount(accountId);
  const match=/^(?:http:\/\/steamcommunity\.com(?::80)?|https:\/\/steamcommunity\.com(?::443)?)\/(profiles\/\d{17}|id\/[A-Za-z0-9_-]{1,100})\/?$/.exec(original);
  if(!match||match[1]!.startsWith('profiles/')&&match[1]!==`profiles/${id}`)throw new Error('steam_profile_url_mismatch');
  return match[1]!;
}
export function parseSteamProfileArchiveIndex(input:unknown,original:string,accountId:string,beforeAt:string){
  Time.parse(beforeAt);const location=steamProfileLocation(original,accountId);
  const rows=z.array(z.array(z.string()).length(3)).max(6).parse(input);if(!rows.length)return [];
  if(JSON.stringify(rows[0])!==JSON.stringify(['timestamp','original','digest']))throw new Error('profile_index_header');
  return rows.slice(1).map(([timestamp,url,digest])=>{
    const capturedAt=archiveStampAt(timestamp!);
    if(steamProfileLocation(url!,accountId)!==location||capturedAt>=beforeAt||!/^[A-Z2-7]{32}$/.test(digest!))throw new Error('profile_index_record');
    return {timestamp:timestamp!,original:url!,digest:digest!,capturedAt};
  }).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
}
function profileJson(html:string){
  // Parse a JSON assignment at the start of one inline script, never evaluate provider JS.
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if(scripts.reduce((n,m)=>n+[...m[2]!.matchAll(/\bg_rgProfileData\s*=/g)].length,0)!==1)
    throw new Error('profile_data_missing_or_ambiguous');
  const candidates=scripts.filter(m=>!(/\bsrc\s*=/i.test(m[1]!)))
    .map(m=>m[2]!).filter(s=>/^\s*(?:var\s+)?g_rgProfileData\s*=/.test(s));
  if(candidates.length!==1)throw new Error('profile_data_missing_or_ambiguous');
  const text=candidates[0]!.replace(/^\s*(?:var\s+)?g_rgProfileData\s*=\s*/,'');
  if(text[0]!=='{')throw new Error('profile_not_json');
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=0;i<text.length;i++){
    const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
    else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}
  }
  if(end<0||!/^\s*;/.test(text.slice(end)))throw new Error('profile_not_json');
  const json=text.slice(0,end);
  for(const key of ['steamid','url','personaname'])
    if([...json.matchAll(new RegExp(`"${key}"\\s*:`, 'g'))].length!==1)throw new Error('profile_key_missing_or_ambiguous');
  return z.object({steamid:z.string().regex(/^\d{17}$/),url:z.string().max(300),personaname:z.string().max(120).nullable()}).parse(JSON.parse(json));
}
export function verifyArchivedSteamProfile(snapshot:TournamentArchiveSnapshot,accountId:string){
  const location=steamProfileLocation(snapshot.original,accountId),capturedAt=archiveStampAt(snapshot.timestamp);Time.parse(snapshot.fetchedAt);
  if(snapshot.originalLink!==snapshot.original||new Date(snapshot.mementoDatetime).toISOString()!==capturedAt||capturedAt>snapshot.fetchedAt)
    throw new Error('profile_archive_origin_or_time');
  if(snapshot.bytes.byteLength>2*1024*1024||!/^[A-Z2-7]{32}$/.test(snapshot.digest)||archiveDigest(snapshot.bytes)!==snapshot.digest)
    throw new Error('profile_archive_size_or_digest');
  const bytes=snapshot.encoding==='gzip'?gunzipSync(snapshot.bytes,{maxOutputLength:4*1024*1024}):
    snapshot.encoding==='identity'?Buffer.from(snapshot.bytes):null;
  if(bytes===null||bytes.byteLength>4*1024*1024)throw new Error('profile_encoding_or_size');
  const p=profileJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(p.steamid!==steam64FromAccount(accountId)||steamProfileLocation(p.url,accountId)!==location)throw new Error('profile_embedded_identity_mismatch');
  const projection={accountId,steam64:p.steamid,alias:p.personaname?.trim()||null};
  return {policyVersion:'steam-profile-account-observation-v1',status:'verified_archived_profile' as const,
    scope:'self_published_profile_account_alias_only' as const,accountNamespace:'steam32' as const,...projection,
    sourceUrl:snapshot.original,capturedAt,knownByAt:capturedAt,fetchedAt:snapshot.fetchedAt,
    cdxDigest:snapshot.digest,payloadSha256:hash(snapshot.bytes),decodedSha256:hash(bytes),projectionSha256:hash(JSON.stringify(projection)),
    canonicalPlayerId:null,verifiedPersonIdentity:false,teamId:null,proStatus:null,
    autoIdentityMergeEligible:false,verifiedMapLineups:0,trainingExamples:0,trainingReady:false,deployable:false};
}
const ProfileProof=z.object({status:z.literal('verified_archived_profile'),scope:z.literal('self_published_profile_account_alias_only'),
  accountNamespace:z.literal('steam32'),accountId:Steam32Schema,steam64:z.string(),sourceUrl:z.string(),
  knownByAt:Time,fetchedAt:Time,payloadSha256:Sha,verifiedPersonIdentity:z.literal(false),autoIdentityMergeEligible:z.literal(false)});
/** Organization associations and self-published profiles remain distinct. Neither certifies a person or a map lineup. */
export function auditHistoricalAccountSources(teams:readonly ReturnType<typeof verifyArchivedTeamAccounts>[],profiles:readonly ReturnType<typeof verifyArchivedSteamProfile>[],map:unknown,snapshotAt:string){
  const teamCoverage=auditHistoricalMapAccounts(teams,map,snapshotAt);if(profiles.length>50)throw new Error('profile_proof_limit');
  const usable=new Map<string,z.infer<typeof ProfileProof>>();
  for(const value of profiles){const p=ProfileProof.parse(value);steamProfileLocation(p.sourceUrl,p.accountId);
    if(p.steam64!==steam64FromAccount(p.accountId)||p.knownByAt>p.fetchedAt)throw new Error('profile_proof_invalid');
    if(p.knownByAt<teamCoverage.startedAt&&p.fetchedAt<=snapshotAt)usable.set(`${p.sourceUrl}:${p.knownByAt}:${p.payloadSha256}`,p);
  }
  const players=teamCoverage.players.map(p=>{
    const found=[...usable.values()].filter(v=>v.accountId===p.accountId),organizationObserved=p.accountEvidenceStatus==='observed_before_cutoff';
    return {playerSlot:p.playerSlot,accountId:p.accountId,organizationObserved,profileObserved:found.length>0,
      observedBeforeCutoff:organizationObserved||found.length>0,profilePayloadHashes:[...new Set(found.map(v=>v.payloadSha256))].sort(),
      profileKnownByAt:found.length?found.map(v=>v.knownByAt).sort()[0]!:null,canonicalPlayerId:null};
  });
  const result={policyVersion:'historical-account-sources-v1',scope:'source_account_observations_not_canonical_identity' as const,
    matchId:teamCoverage.matchId,snapshotAt,teamCoverage,players,mapCount:1,knownMapAccounts:teamCoverage.knownMapAccounts,
    organizationObservedAccounts:teamCoverage.accountsObservedBeforeCutoff,profileObservedAccounts:players.filter(p=>p.profileObserved).length,
    profileOnlyAccounts:players.filter(p=>p.profileObserved&&!p.organizationObserved).length,
    accountsObservedBeforeCutoff:players.filter(p=>p.observedBeforeCutoff).length,
    accountsWithoutMatchingArchive:players.filter(p=>p.accountId!==null&&!p.observedBeforeCutoff).length,
    unknownAccountRows:teamCoverage.unknownAccountRows,canonicalPlayersCreated:0,verifiedMapLineups:0,trainingExamples:0,
    strictDatasetStatus:'unavailable' as const,trainingReady:false,deployable:false};
  return {...result,fingerprint:hash(JSON.stringify(result))};
}
