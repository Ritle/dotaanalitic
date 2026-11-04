import {afterEach,expect,it,vi} from 'vitest';
import {createScheduledForecast,scheduledScenarioWarning} from '../src/scheduled-forecasts';
import {ownerAuth} from '../src/auth';
import {syntheticScheduledTarget,syntheticScheduledView} from '../../../tests/helpers/scheduled-forecast-view';
afterEach(()=>{vi.unstubAllGlobals();ownerAuth.value=null;});
it('compares the exact saved map context without changing lineups, orientation or unknown fields',()=>{
  const t=syntheticScheduledTarget(),s=syntheticScheduledView().scenario;
  expect(scheduledScenarioWarning(t,s)).toBeNull();
  for(const input of [{...s.input,teamAId:'22',teamBId:'11'},{...s.input,scheduledAt:null},
    {...s.input,context:{...s.input.context,leagueId:null}},{...s.input,context:{...s.input.context,mapNumber:2}}])
    expect(scheduledScenarioWarning(t,{...s,input})).not.toBeNull();
  expect(s.input.lineupA[0]?.playerId).toBe('101');
});
it('retains the UUID, frozen body and cookies/CSRF across safe retries and validates the real-map response',async()=>{
  const result=syntheticScheduledView(),body={requestId:result.requestId,scenarioId:result.scenario.id,expectedRevision:1,targetSha256:result.target.targetSha256,targetScope:null};
  const calls:RequestInit[]=[];vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{calls.push(init);return new Response(JSON.stringify(result));});
  for(let i=0;i<2;i++)expect(await createScheduledForecast(result.target.targetRequestId,body,new AbortController().signal)).toEqual(result);
  expect(calls[0]?.body).toBe(calls[1]?.body);expect(calls[0]).toMatchObject({cache:'no-store',credentials:'same-origin',headers:{'x-csrf-token':''}});
});
it('keeps session, malformed response, conflict and network errors safe and understandable',async()=>{
  const r=syntheticScheduledView(),body={requestId:r.requestId,scenarioId:r.scenario.id,expectedRevision:1,targetSha256:r.target.targetSha256,targetScope:null};
  const run=()=>createScheduledForecast(r.target.targetRequestId,body,new AbortController().signal);
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({error:{code:'scheduled_target_source_changed',message:'private-do-not-echo'}}),{status:409}));
  await expect(run()).rejects.toThrow('Расписание изменилось');
  vi.stubGlobal('fetch',async()=>new Response('private-do-not-echo'));await expect(run()).rejects.toThrow('Не удалось проверить');
  vi.stubGlobal('fetch',async()=>{throw Error('private-do-not-echo');});await expect(run()).rejects.toThrow('Ответ не получен');
  vi.stubGlobal('fetch',async()=>new Response('',{status:401}));await expect(run()).rejects.toThrow('Сессия завершена');expect(ownerAuth.value).toBeNull();
});
