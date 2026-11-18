import type {LiveResponse} from '../../api/src/modules/live/contract';
export function liveRefreshAction(input:{data:LiveResponse|undefined;now:number;receivedAt:number;paused:boolean;owner:boolean;lastAttemptAt:number;lastReadAt:number}):'read'|'refresh'|null{
 const {data,now,receivedAt,paused,owner,lastAttemptAt,lastReadAt}=input;
 if(paused||!data?.configured)return null;
 const serverNow=Date.parse(data.computedAt)+Math.max(0,now-receivedAt);
 if(!Number.isFinite(serverNow))return null;
 if(!owner||data.refreshing)return now-lastReadAt>=60000?'read':null;
 if(data.retryAt&&Date.parse(data.retryAt)>serverNow)return null;
 if(data.snapshot&&data.expiresAt&&Date.parse(data.expiresAt)>serverNow)return null;
 return now-lastAttemptAt>=60000?'refresh':null;
}
