import {afterEach,expect,it,vi} from 'vitest';
import {postScheduledResult} from '../src/scheduled-results';
import {ownerAuth} from '../src/auth';
afterEach(()=>{vi.unstubAllGlobals();ownerAuth.value=null;});
const schema={parse:(v:unknown)=>v};
it('retries the exact frozen mutation with credentials, CSRF and no-store',async()=>{
  const calls:RequestInit[]=[];vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{calls.push(init);return new Response('{}');});
  const body={requestId:'synthetic-same-request',expectedRevision:0};
  for(let i=0;i<2;i++)await postScheduledResult('synthetic/outcomes',schema,body,new AbortController().signal);
  expect(calls[0]?.body).toBe(calls[1]?.body);expect(calls[0]).toMatchObject({credentials:'same-origin',cache:'no-store',headers:{'x-csrf-token':''}});
});
it('handles conflicts, session expiry and untrusted error content without echoing it',async()=>{
  const run=()=>postScheduledResult('synthetic/outcomes',schema,{},new AbortController().signal);
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({error:{code:'CONFLICT',message:'private-do-not-echo'}}),{status:409}));await expect(run()).rejects.toThrow('Редакция сверки изменилась');
  vi.stubGlobal('fetch',async()=>new Response('private-do-not-echo',{status:500}));await expect(run()).rejects.toThrow('Сервис не подтвердил запись');
  vi.stubGlobal('fetch',async()=>new Response('private-do-not-echo'));await expect(run()).rejects.toThrow('Не удалось проверить');
  vi.stubGlobal('fetch',async()=>new Response('',{status:401}));await expect(run()).rejects.toThrow('Сессия завершена');expect(ownerAuth.value).toBeNull();
});
