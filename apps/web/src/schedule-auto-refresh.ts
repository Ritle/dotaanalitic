export const AUTO_SCHEDULE_MS=5*60_000;
export const AUTO_SCHEDULE_CHECK_MS=30_000;
interface AutoScheduleData{configured:boolean;computedAt:string;expiresAt:string|null;retryAt:string|null;refreshing:boolean;snapshot:unknown|null}
interface AutoScheduleInput{data:AutoScheduleData|undefined;now:number;receivedAt:number;enabled:boolean;allowed:boolean;paused:boolean;lastAttemptAt?:number;lastReadAt?:number}
/** Only fetching policy; source lease, clock, quota and Retry-After remain authoritative on the server. */
export function scheduleAutoAction(input:AutoScheduleInput):'read'|'refresh'|null{
 const {data,now,receivedAt,enabled,allowed,paused,lastAttemptAt,lastReadAt}=input;
 if(!enabled||!allowed||paused||!data?.configured)return null;
 const serverNow=Date.parse(data.computedAt)+Math.max(0,now-receivedAt);
 if(!Number.isFinite(serverNow))return null;
 if(data.refreshing)return lastReadAt===undefined||now-lastReadAt>=AUTO_SCHEDULE_CHECK_MS?'read':null;
 if(data.retryAt&&Date.parse(data.retryAt)>serverNow)return null;
 if(data.snapshot&&(!data.expiresAt||Date.parse(data.expiresAt)>serverNow))return null;
 if(lastAttemptAt!==undefined&&now-lastAttemptAt<AUTO_SCHEDULE_MS)return null;
 return 'refresh';
}
