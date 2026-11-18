import {test,expect} from 'vitest';
import {scheduleAutoAction,AUTO_SCHEDULE_MS} from '../src/schedule-auto-refresh';
const now=Date.parse('2026-11-12T12:00:00.000Z');
const ready={configured:true,computedAt:new Date(now).toISOString(),expiresAt:new Date(now+AUTO_SCHEDULE_MS).toISOString(),retryAt:null,refreshing:false,status:'ready' as const,snapshot:{},reason:null};
const input={data:ready,now,receivedAt:now,enabled:true,allowed:true,paused:false};
test('automatic refresh uses server expiry and the server clock, not the client wall-clock offset',()=>{
 expect(scheduleAutoAction(input)).toBe(null);
 expect(scheduleAutoAction({...input,now:now+AUTO_SCHEDULE_MS})).toBe('refresh');
 expect(scheduleAutoAction({...input,now:now+86400000,receivedAt:now+86400000})).toBe(null);
});
test('not loaded data loads once and unsuccessful or pending refreshes impose a five-minute local floor',()=>{
 const missing={...input,data:{...ready,snapshot:null,status:'unavailable' as const,expiresAt:null}};
 expect(scheduleAutoAction(missing)).toBe('refresh');
 expect(scheduleAutoAction({...missing,lastAttemptAt:now-1})).toBe(null);
 expect(scheduleAutoAction({...missing,lastAttemptAt:now-AUTO_SCHEDULE_MS})).toBe('refresh');
});
test('Retry-After and foreign refresh leases cause no source retry loop',()=>{
 expect(scheduleAutoAction({...input,data:{...ready,snapshot:null,retryAt:new Date(now+86400000).toISOString()}})).toBe(null);
 expect(scheduleAutoAction({...input,data:{...ready,refreshing:true}})).toBe('read');
 expect(scheduleAutoAction({...input,data:{...ready,refreshing:true},lastReadAt:now-1})).toBe(null);
});
test('disabled, hidden/offline, selected/editor, user role and unconfigured source never start provider work',()=>{
 const due={...input,now:now+AUTO_SCHEDULE_MS};
 for(const change of [{enabled:false},{allowed:false},{paused:true},{data:{...ready,configured:false}},{data:undefined}])expect(scheduleAutoAction({...due,...change})).toBe(null);
});
