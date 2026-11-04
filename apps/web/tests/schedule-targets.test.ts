import {afterEach,expect,it,vi} from 'vitest';
import {scheduleTargetCall} from '../src/schedule-targets';
import {ownerAuth} from '../src/auth';
const schema={parse:(v:unknown)=>v};
afterEach(()=>{vi.unstubAllGlobals();ownerAuth.value=null;});
it('retries identical requests with cookies, CSRF and no-store policy',async()=>{
  const fetcher=vi.fn(async()=>new Response('{}'));vi.stubGlobal('fetch',fetcher);
  for(let i=0;i<2;i++)await scheduleTargetCall('schedule-targets',schema,new AbortController().signal,{requestId:'synthetic'});
  const calls=fetcher.mock.calls as unknown as [string,RequestInit][];expect(calls[0]![1].body).toBe(calls[1]![1].body);
  expect(calls[0]![1]).toMatchObject({credentials:'same-origin',cache:'no-store',headers:{'x-csrf-token':''}});
});
it('shows safe Russian errors for conflicts, malformed data, network failures and expired sessions',async()=>{
  const call=()=>scheduleTargetCall('schedule-targets',schema,new AbortController().signal);
  vi.stubGlobal('fetch',async()=>new Response('private',{status:409}));await expect(call()).rejects.toThrow('редакция изменились');
  vi.stubGlobal('fetch',async()=>new Response('private'));await expect(call()).rejects.toThrow('Не удалось проверить');
  vi.stubGlobal('fetch',async()=>{throw Error('private');});await expect(call()).rejects.toThrow('Ответ не получен');
  vi.stubGlobal('fetch',async()=>new Response('',{status:401}));await expect(call()).rejects.toThrow('Сессия завершена');expect(ownerAuth.value).toBeNull();
});
