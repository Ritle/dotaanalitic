import {z} from 'zod';

/** Operational freshness policy, aligned with the existing five-minute schedule cache. */
export const SCHEDULE_FRESHNESS_POLICY='schedule-source-age-v1' as const;
export const SCHEDULE_MAX_AGE_MS=300_000;
const Clock=z.iso.datetime({precision:6});
const FetchClock=z.iso.datetime({precision:3});
const micros=(value:string)=>BigInt(Date.parse(value))*1000n+BigInt((/\.(\d+)Z$/.exec(value)?.[1]?.slice(3,6)??'').padEnd(3,'0'));
export function scheduleFreshnessReason(fetchedAt:string,checkedAt:string):'SCHEDULE_SOURCE_STALE'|'SCHEDULE_SOURCE_CLOCK_INVALID'|null{
  if(!FetchClock.safeParse(fetchedAt).success||!Clock.safeParse(checkedAt).success)return 'SCHEDULE_SOURCE_CLOCK_INVALID';
  const fetched=micros(fetchedAt),checked=micros(checkedAt);
  if(fetched>checked)return 'SCHEDULE_SOURCE_CLOCK_INVALID';
  return checked-fetched>=BigInt(SCHEDULE_MAX_AGE_MS)*1000n?'SCHEDULE_SOURCE_STALE':null;
}
export const SCHEDULE_FRESHNESS_MESSAGES:Readonly<Record<string,string>>={
  SCHEDULE_SOURCE_STALE:'Сведения об этой встрече старше 5 минут. Обновите расписание перед сохранением назначения или новым прогнозом.',
  SCHEDULE_SOURCE_CLOCK_INVALID:'Время получения расписания некорректно. Обновите источник и проверьте часы сервера.'
};
