import {test,expect} from 'vitest';
import {liveRefreshAction} from '../src/live-refresh';
import type {LiveResponse} from '../../api/src/modules/live/contract';
const now=Date.parse('2026-11-13T13:00:00.000Z');
const data:LiveResponse={configured:true,computedAt:new Date(now).toISOString(),snapshot:null,status:'unavailable',reason:'not_loaded',expiresAt:null,retryAt:null,refreshing:false};
const base={data,now,receivedAt:now,paused:false,owner:true,lastAttemptAt:0,lastReadAt:now};
test('owner loads missing data once a minute, paused tabs never request',()=>{
 expect(liveRefreshAction(base)).toBe('refresh');expect(liveRefreshAction({...base,lastAttemptAt:now-59000})).toBeNull();expect(liveRefreshAction({...base,paused:true})).toBeNull();
});
test('reader only polls cache; provider cooldown and another refresh are respected',()=>{
 expect(liveRefreshAction({...base,owner:false})).toBeNull();expect(liveRefreshAction({...base,owner:false,lastReadAt:now-60000})).toBe('read');
 expect(liveRefreshAction({...base,data:{...data,retryAt:new Date(now+120000).toISOString()}})).toBeNull();
 expect(liveRefreshAction({...base,data:{...data,refreshing:true},lastReadAt:now-60000})).toBe('read');
});
test('server time determines expiry despite a different browser clock',()=>{
 const snapshot={data:[],source:{provider:'pandascore',adapterVersion:'pandascore-running-v1',endpoint:'/dota2/matches/running?sort=scheduled_at,id&page=1&per_page=20',fetchedAt:data.computedAt,knownAt:null,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:null}} as const;
 const cached={...data,snapshot:{...snapshot,data:[]},expiresAt:new Date(now+60000).toISOString()};
 expect(liveRefreshAction({...base,data:cached,now:100000,receivedAt:100000})).toBeNull();
 expect(liveRefreshAction({...base,data:cached,now:161000,receivedAt:100000})).toBe('refresh');
});
