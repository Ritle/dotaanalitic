import {afterEach,expect,it,vi} from 'vitest';
import {createJournal,metricLabel,journalReason,readJournal} from '../src/journal';
import {V1JournalViewSchema} from '@dota/contracts';
import {ownerAuth} from '../src/auth';
import {journalViewFixture} from '../../../tests/helpers/journal-view';
afterEach(()=>{vi.unstubAllGlobals();ownerAuth.value=null;});
it('sends the same idempotency request and CSRF/cookie policy on retries',async()=>{
  const view=journalViewFixture(),body={requestId:view.requestId,filters:view.summary.filters};
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(view)));vi.stubGlobal('fetch',fetcher);
  await createJournal(body,new AbortController().signal);await createJournal(body,new AbortController().signal);
  const calls=fetcher.mock.calls as unknown as [string,RequestInit][];expect(calls[0]![1].body).toBe(calls[1]![1].body);
  expect(calls[0]![1]).toMatchObject({credentials:'same-origin',cache:'no-store',headers:{'x-csrf-token':''}});
});
it('uses nullable values and explains primary selection and excluded attempts in Russian',()=>{
  expect(metricLabel(null,true)).toBe('—');expect(metricLabel(0,true)).toContain('0');
  expect(journalReason('LATER_SUCCESSFUL_PRE_START_FORECAST')).toContain('более поздний');expect(journalReason('NO_ACTIVE_MODEL')).toContain('Нет активной');
});
it('rejects malformed and private server bodies, expired sessions and network errors safely',async()=>{
  vi.stubGlobal('fetch',async()=>new Response('private-value',{status:422}));
  await expect(readJournal('',V1JournalViewSchema,new AbortController().signal)).rejects.toThrow('Полный журнал');
  vi.stubGlobal('fetch',async()=>new Response('{"error":{"code":"JOURNAL_CODE_CHANGED","message":"private-value"}}',{status:503}));
  await expect(readJournal('',V1JournalViewSchema,new AbortController().signal)).rejects.toThrow('Перезапустите локальный сервер');
  vi.stubGlobal('fetch',async()=>new Response('{"private":"secret"}'));
  await expect(readJournal('',V1JournalViewSchema,new AbortController().signal)).rejects.toThrow('Не удалось проверить');
  vi.stubGlobal('fetch',async()=>{throw Error('private-value');});
  await expect(readJournal('',V1JournalViewSchema,new AbortController().signal)).rejects.toThrow('Ответ не получен');
  vi.stubGlobal('fetch',async()=>new Response('',{status:401}));
  await expect(readJournal('',V1JournalViewSchema,new AbortController().signal)).rejects.toThrow('Сессия завершена');expect(ownerAuth.value).toBeNull();
});
