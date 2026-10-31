import {createHash} from 'node:crypto';
import {z} from 'zod';
const Id=z.string().regex(/^[1-9]\d{0,19}$/),Time=z.number().int().min(0).max(253402300799);
export const SteamEventSchema=z.object({gid:Id,appid:z.literal(570),clan_steamid:z.literal('103582791433224455'),
  event_name:z.string().max(2000),published:z.union([z.literal(0),z.literal(1)]),hidden:z.union([z.literal(0),z.literal(1)]),
  rtime32_start_time:Time,rtime32_last_modified:Time,build_id:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  announcement_body:z.object({gid:Id,event_gid:Id,clanid:z.literal('3703047'),headline:z.string().max(2000),
    posttime:Time,updatetime:Time,body:z.string().max(1024*1024)})}).superRefine((r,c)=>{
  if(r.gid!==r.announcement_body.event_gid)c.addIssue({code:'custom',message:'Event/body link mismatch'});
});
export const SteamEventResponseSchema=z.object({success:z.literal(1),event:SteamEventSchema});
export const steamBodySha256=(body:string)=>createHash('sha256').update(body,'utf8').digest('hex');
export function eventProjection(input:unknown){
  const e=SteamEventSchema.parse(input),iso=(n:number)=>n?new Date(n*1000).toISOString():null;
  return {eventId:e.gid,announcementId:e.announcement_body.gid,title:e.event_name,published:e.published===1,hidden:e.hidden===1,
    eventStartsAt:iso(e.rtime32_start_time),eventModifiedAt:iso(e.rtime32_last_modified),
    bodyPostedAt:iso(e.announcement_body.posttime),bodyModifiedAt:iso(e.announcement_body.updatetime),
    buildId:e.build_id?String(e.build_id):null,bodySha256:steamBodySha256(e.announcement_body.body)};
}
/** Parse only the archived public event store. Never execute HTML/scripts or follow linked notes. */
export function extractArchivedSteamEvent(html:string,eventId:string){
  const attributes=[...html.matchAll(/\bdata-partnereventstore="([^"]*)"/g)];
  if(attributes.length!==1)throw new Error('archive_event_store_missing_or_ambiguous');
  const text=attributes[0]![1]!.replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  const rows=z.array(z.unknown()).max(100).parse(JSON.parse(text));
  const matching=rows.filter(r=>r!==null&&typeof r==='object'&&'gid' in r&&r.gid===eventId);
  if(matching.length!==1)throw new Error('archive_event_identity_missing_or_ambiguous');
  return SteamEventSchema.parse(matching[0]);
}
