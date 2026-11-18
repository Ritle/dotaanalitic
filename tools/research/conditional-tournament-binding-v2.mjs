/** Offline reviewed evidence only. No registration, active-owner check, HTTP or model permission. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
const policySha='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f';
export const bindingV2Sha=value=>createHash('sha256').update(value).digest('hex');
const Time=z.string().datetime({precision:3}),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Key=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),Note=z.string().trim().min(20).max(2000);
const Excerpt=z.string().min(1).max(8000),Day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Url=z.string().url().max(1024).refine(s=>{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash
 &&['blast.tv','pro.eslgaming.com','api.opendota.com','www.opendota.com','opendota.com'].includes(u.hostname);});
const Source=z.object({id:Key,url:Url,bodyText:z.string().min(1).max(16777216),sha256:Hash,fetchedAt:Time,
 knownAt:z.null(),httpStatus:z.literal(200),representation:z.literal('retained_http_utf8')}).strict();
const Calendar=z.object({sourceId:Key,editionExcerpt:Excerpt,periodExcerpt:Excerpt,fromDate:Day,throughDate:Day,reviewNote:Note,
 startBound:z.object({at:Time,basis:z.literal('owner_reviewed_lower_bound'),explanation:Note}).strict()}).strict();
const Link=z.object({sourceId:Key,section:Excerpt,href:Url,reviewNote:Note}).strict();
const Binding=z.object({editionKey:z.string().min(1).max(256),leagueId:Id.nullable(),calendar:Calendar.nullable(),
 native:z.object({sourceId:Key}).strict().nullable(),link:Link.nullable()}).strict();
export const TournamentBindingReviewV2Schema=z.object({format:z.literal('conditional-tournament-binding-review-v2'),
 policySha256:Hash,syntheticOnly:z.boolean(),reviewedAt:Time,reviewerUserId:z.string().uuid().nullable(),
 sources:z.array(Source).max(12),bindings:z.array(Binding).max(2)}).strict();
const normalize=s=>s.trim().replace(/\s+/g,' ').toLowerCase();
const outOfScope=s=>/qualif|division\s*(?:2|ii)\b/i.test(s);
const containsToken=(text,token)=>new RegExp('(?:^|[^\\p{L}\\p{N}])'+token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^\\p{L}\\p{N}])','u').test(text);
function hasLiteralAnchor(section,href){
 for(const match of section.matchAll(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
  let attributes=match[0].slice(2,-1),valid=true;const seen=new Set(),links=[];
  while(attributes.trim()&&attributes.trim()!=='/'){
   const a=/^\s+([a-zA-Z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(attributes);
   if(!a){valid=false;break;}const name=a[1].toLowerCase();if(seen.has(name)){valid=false;break;}seen.add(name);
   if(name==='href')links.push(a[2]??a[3]??a[4]??null);attributes=attributes.slice(a[0].length);
  }
  if(valid&&links.length===1&&links[0]===href)return true;
 }
 return false;
}
/** JSON.parse is authoritative for syntax; tokens additionally reject duplicate object keys. */
export function parseBindingEvidenceJson(text){
 assert(typeof text==='string'&&Buffer.byteLength(text)<=33554432,'json_byte_limit');
 const value=JSON.parse(text),stack=[];
 for(const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)){
  const t=token[0],top=stack.at(-1);
  if(t==='{'||t==='['){assert(stack.length<100,'json_nesting_limit');stack.push({object:t==='{',key:true,keys:new Set()});}
  else if(t==='}'||t===']')stack.pop();
  else if(t===','&&top?.object)top.key=true;
  else if(t===':'&&top?.object)top.key=false;
  else if(t.startsWith('"')&&top?.object&&top.key){const key=JSON.parse(t);assert(!top.keys.has(key),'duplicate_json_key');top.keys.add(key);}
 }
 return value;
}
function nativeRows(text){
 const raw=parseBindingEvidenceJson(text);assert(Array.isArray(raw)&&raw.length<=30000,'catalogue_array_required');
 const ids=new Set();return raw.map(row=>{
  assert(row&&typeof row==='object'&&!Array.isArray(row),'catalogue_row');
  const id=row.leagueid;assert(typeof id==='string'||typeof id==='number'&&Number.isSafeInteger(id),'unsafe_native_id');
  const leagueId=Id.parse(String(id));assert(!ids.has(leagueId),'duplicate_native_id');ids.add(leagueId);
  assert(typeof row.name==='string'&&row.name.length<=1000,'native_name');
  assert(row.tier===undefined||row.tier===null||typeof row.tier==='string','native_tier');
  return {leagueId,name:row.name,tier:row.tier??null};
 });
}
/** Explicit supported reference, not an inferred provider namespace or arbitrary number in text. */
function nativeLinkId(href){
 const u=new URL(href),match=/^\/leagues\/([1-9]\d{0,18})\/?$/.exec(u.pathname);
 return ['www.opendota.com','opendota.com'].includes(u.hostname)&&match?Id.parse(match[1]):null;
}
export function inspectTournamentBindingsV2(raw,policyText,checkedAt){
 Time.parse(checkedAt);assert.equal(bindingV2Sha(policyText),policySha,'policy_changed');
 assert(Buffer.byteLength(JSON.stringify(raw))<=33554432,'review_byte_limit');
 const p=TournamentBindingReviewV2Schema.parse(raw),policy=JSON.parse(policyText),proposal=policy.proposedRegistration;
 assert.equal(p.policySha256,policySha,'policy_hash');assert(p.reviewedAt<=checkedAt,'review_from_future');
 assert.equal(new Set(p.sources.map(s=>s.id)).size,p.sources.length,'duplicate_source_id');
 assert.equal(new Set(p.bindings.map(b=>b.editionKey)).size,p.bindings.length,'duplicate_edition_review');
 const selectedIds=p.bindings.map(b=>b.leagueId).filter(Boolean);assert.equal(new Set(selectedIds).size,selectedIds.length,'duplicate_selected_native_id');
 assert(p.bindings.every(b=>proposal.events.some(e=>e.name===b.editionKey)),'unknown_edition');
 const sources=new Map(),catalogues=new Map();
 for(const s of p.sources){assert(Buffer.byteLength(s.bodyText)<=16777216,'source_byte_limit');
  assert.equal(bindingV2Sha(s.bodyText),s.sha256,'source_hash');assert(s.fetchedAt<=p.reviewedAt,'source_after_review');sources.set(s.id,s);}
 const source=id=>{const s=sources.get(id);assert(s,'undeclared_source');return s;};
 // Validate every referenced source before assessing readiness; a missing field is not permission to hide a broken reference.
 for(const b of p.bindings)for(const part of [b.calendar,b.native,b.link])if(part)source(part.sourceId);
 const reasons=[];if(!p.reviewerUserId)reasons.push('OWNER_REVIEW_MISSING');
 if(checkedAt>=proposal.decisionDeadline)reasons.push('REGISTRATION_DEADLINE_PASSED');
 if(checkedAt>=proposal.from)reasons.push('TARGET_WINDOW_STARTED');
 const bindings=proposal.events.map(event=>{
  const b=p.bindings.find(b=>b.editionKey===event.name),failures=[],evidence=new Map();
  const use=id=>{const s=source(id);evidence.set(id,{id:s.id,url:s.url,sha256:s.sha256,fetchedAt:s.fetchedAt,knownAt:null});return s;};
  let name=null;
  if(!b)failures.push('EDITION_REVIEW_MISSING');
  else{
   if(!b.leagueId)failures.push('NATIVE_ID_MISSING');
   if(!b.calendar)failures.push('CALENDAR_EVIDENCE_MISSING');
   else{const c=b.calendar,s=use(c.sourceId);
    if(s.url!==event.source)failures.push('CALENDAR_SOURCE_MISMATCH');
    if(!s.bodyText.includes(c.editionExcerpt)||normalize(c.editionExcerpt)!==normalize(event.name))failures.push('CALENDAR_EDITION_UNVERIFIED');
    if(!s.bodyText.includes(c.periodExcerpt)||c.fromDate!==event.fromDate||c.throughDate!==event.throughDate)failures.push('CALENDAR_PERIOD_UNVERIFIED');
    if(c.startBound.at<=checkedAt||c.startBound.at>event.fromDate+'T00:00:00.000Z')failures.push('START_BOUND_INVALID');
   }
   if(!b.native)failures.push('NATIVE_CATALOGUE_MISSING');
   else{const s=use(b.native.sourceId);
    if(s.url!=='https://api.opendota.com/api/leagues')failures.push('NATIVE_SOURCE_ENDPOINT_MISMATCH');
    else{
     if(!catalogues.has(s.id))catalogues.set(s.id,nativeRows(s.bodyText));const rows=catalogues.get(s.id),row=rows.find(r=>r.leagueId===b.leagueId);
     if(!row)failures.push('NATIVE_RECORD_NOT_FOUND');
     else{name=row.name;if(normalize(row.name)!==normalize(event.name)||outOfScope(row.name))failures.push('NATIVE_EDITION_OR_STAGE_MISMATCH');
      if(!['professional','premium'].includes(row.tier))failures.push('NATIVE_PRO_STATUS_UNVERIFIED');}
     if(rows.filter(r=>normalize(r.name)===normalize(event.name)).length>1)failures.push('AMBIGUOUS_NATIVE_EDITION');
    }
   }
   if(!b.link)failures.push('ORGANIZER_NATIVE_LINK_MISSING');
   else{const link=b.link,s=use(link.sourceId);
    if(new URL(s.url).hostname!==new URL(event.source).hostname)failures.push('ORGANIZER_HOST_MISMATCH');
    // This is an owner-reviewed literal source excerpt, not a DOM authenticity/signature assertion.
    if(!s.bodyText.includes(link.section)||!containsToken(normalize(link.section),normalize(event.name))||!containsToken(link.section,event.fromDate.slice(0,4))
      ||outOfScope(link.section)||!hasLiteralAnchor(link.section,link.href)||nativeLinkId(link.href)!==b.leagueId)failures.push('ORGANIZER_NATIVE_LINK_UNVERIFIED');
   }
  }
  const bindingReviewed=failures.length===0;
  return {editionKey:event.name,stage:'main_event',candidateLeagueId:b?.leagueId??null,nativeName:name,
   leagueId:bindingReviewed?b.leagueId:null,bindingReviewed,startBound:bindingReviewed?b.calendar.startBound:null,
   evidence:[...evidence.values()],evidenceSha256:b?bindingV2Sha(JSON.stringify(b)):null,reasons:failures};
 });
 const bindingsReady=reasons.length===0&&bindings.every(b=>b.bindingReviewed);
 return {format:'conditional-tournament-binding-report-v2',checkedAt,reviewedAt:p.reviewedAt,policySha256:policySha,
  reviewSha256:bindingV2Sha(JSON.stringify(p)),syntheticOnly:p.syntheticOnly,status:bindingsReady?'reviewed_bindings_only':'unavailable',
  bindingsReady,reasons,bindings,trustBoundary:'owner_reviewed_retained_sources_not_remote_signature',
  calendarDatesBasis:'owner_reviewed_literal_excerpt_not_automatic_date_extraction',ownerAuthenticated:false,
  registrationReady:false,registrationPerformed:false,collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false};
}
