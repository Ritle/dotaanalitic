import {test,expect} from 'vitest';
import {SchedulePageQuerySchema,SchedulePageCacheDataSchema,SchedulePageResponseSchema,schedulePageEndpoint,UpcomingScheduleResponseSchema} from '../src/index.js';
test('pagination accepts only canonical bounded page strings and defaults to page one',()=>{
 expect(SchedulePageQuerySchema.parse({})).toEqual({page:1});
 for(const page of ['1','2','50'])expect(SchedulePageQuerySchema.parse({page})).toEqual({page:Number(page)});
 for(const page of ['',0,2,'0','51','01','1.5','1e1','-2',['2','3'],null])expect(SchedulePageQuerySchema.safeParse({page}).success).toBe(false);
 expect(SchedulePageQuerySchema.safeParse({page:'2',token:'no'}).success).toBe(false);
});
test('page source is exact and the frozen page-one contract is not broadened',()=>{
 const source={provider:'pandascore',adapterVersion:'synthetic',endpoint:schedulePageEndpoint(2),fetchedAt:'2026-01-01T00:00:00.000Z',knownAt:null,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:null};
 const response={snapshot:{data:[],source},status:'ready',computedAt:source.fetchedAt,expiresAt:null,retryAt:null,refreshing:false,configured:true,reason:null};
 expect(SchedulePageResponseSchema.safeParse(response).success).toBe(true);
 expect(UpcomingScheduleResponseSchema.safeParse(response).success).toBe(false);
 expect(UpcomingScheduleResponseSchema.safeParse({...response,snapshot:{data:[],source:{...source,endpoint:schedulePageEndpoint(1)}}}).success).toBe(true);
 for(const endpoint of [schedulePageEndpoint(2)+'&token=x',source.endpoint.replace('page=2','page=51'),source.endpoint.replace('page=2','page=02'),'/tournaments/1/rosters'])
  expect(SchedulePageCacheDataSchema.safeParse({data:[],source:{...source,endpoint}}).success).toBe(false);
});
