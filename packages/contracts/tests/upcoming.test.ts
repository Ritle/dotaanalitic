import {it,expect} from 'vitest';
import {UpcomingMatchSchema,UpcomingScheduleResponseSchema} from '../src/upcoming.js';
it('upcoming IDs remain strings and unknown schedule/opponents remain explicit',()=>{
  const m=UpcomingMatchSchema.parse({providerMatchId:'9007199254740993',name:null,status:'not_started',scheduledAt:null,
    tournament:{providerTournamentId:'1',name:null},league:{providerLeagueId:'2',name:null},eventSeries:null,seriesBestOf:3,opponents:[]});
  expect(m.providerMatchId).toBe('9007199254740993');expect(m.opponents).toEqual([]);expect(m.scheduledAt).toBeNull();
});
it('unavailable schedule does not fabricate a sample or accept private configuration',()=>{
  const r={status:'unavailable',computedAt:'2026-11-01T00:00:00.000Z',expiresAt:null,retryAt:null,refreshing:false,configured:false,reason:'not_configured',snapshot:null};
  expect(UpcomingScheduleResponseSchema.parse(r).snapshot).toBeNull();expect(()=>UpcomingScheduleResponseSchema.parse({...r,apiToken:'secret'})).toThrow();
});
