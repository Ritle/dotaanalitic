import {expect,test} from 'vitest';
import {scheduleFreshnessReason} from '../src/schedule-freshness.js';
test('schedule age has exact microsecond boundaries and no future-clock tolerance',()=>{
  const fetched='2026-11-05T01:00:00.123Z';
  expect(scheduleFreshnessReason(fetched,'2026-11-05T01:00:00.123000Z')).toBeNull();
  expect(scheduleFreshnessReason(fetched,'2026-11-05T01:05:00.122999Z')).toBeNull();
  expect(scheduleFreshnessReason(fetched,'2026-11-05T01:05:00.123000Z')).toBe('SCHEDULE_SOURCE_STALE');
  expect(scheduleFreshnessReason(fetched,'2026-11-05T01:05:00.123001Z')).toBe('SCHEDULE_SOURCE_STALE');
  expect(scheduleFreshnessReason(fetched,'2026-11-05T01:00:00.122999Z')).toBe('SCHEDULE_SOURCE_CLOCK_INVALID');
});
test('missing or malformed clocks never become fresh',()=>{
  for(const [a,b] of [['bad','bad'],['2026-11-05T01:00:00.000Z','2026-11-05T01:00:00.000Z'],
    ['2026-11-05T01:00:00.000000Z','2026-11-05T01:00:00.000000Z']])
    expect(scheduleFreshnessReason(a!,b!)).toBe('SCHEDULE_SOURCE_CLOCK_INVALID');
});
