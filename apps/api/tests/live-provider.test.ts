import {test,expect,vi} from 'vitest';
import {syntheticSchedule,scheduleToken} from '../../../tests/helpers/upcoming.js';
import {PandaLiveSchema} from '../src/modules/live/provider-schema.js';
import {PandaScoreLiveClient} from '../src/modules/live/provider.js';
import {LIVE_ENDPOINT} from '../src/modules/live/contract.js';
const row=()=>({...syntheticSchedule()[0]!,status:'running',began_at:'2026-11-13T13:00:00Z',results:[{team_id:74002,score:0},{team_id:74001,score:1}]});
test('score maps by numeric team ID, independent of source order; beganAt is normalized',()=>{
 const m=PandaLiveSchema.parse([row()])[0]!;expect(m.seriesScore).toEqual([{providerTeamId:'74001',wins:1},{providerTeamId:'74002',wins:0}]);expect(m.beganAt).toBe('2026-11-13T13:00:00.000Z');
 const r=row();r.opponents.reverse();expect(PandaLiveSchema.parse([r])[0]!.seriesScore?.map(s=>s.wins)).toEqual([0,1]);
});
test.each([null,[],[{team_id:74001,score:1}],[{team_id:74001,score:1},{team_id:74001,score:1}],[{team_id:99999,score:1},{team_id:74002,score:0}],[{team_id:74001,score:null},{team_id:74002,score:0}]])('missing or ambiguous score stays null: %j',results=>{
 expect(PandaLiveSchema.parse([{...row(),results}])[0]!.seriesScore).toBeNull();
});
test('missing participant and missing start time stay unknown; bad IDs/duplicates reject the response',()=>{
 expect(PandaLiveSchema.parse([{...row(),opponents:row().opponents.slice(0,1),began_at:null}])[0]).toMatchObject({seriesScore:null,beganAt:null});
 expect(PandaLiveSchema.safeParse([row(),row()]).success).toBe(false);
 expect(PandaLiveSchema.safeParse([{...row(),id:9007199254740992}]).success).toBe(false);
 expect(PandaLiveSchema.safeParse([{...row(),results:[{team_id:74001,score:-1}]}]).success).toBe(false);
 expect(PandaLiveSchema.parse([])).toEqual([]);
});
test('named client uses only fixed running endpoint, bearer header, durable budget and source hash',async()=>{
 const beforeRequest=vi.fn(async()=>{}),observe=vi.fn(async()=>{});
 const client=new PandaScoreLiveClient({apiToken:scheduleToken},{budget:{beforeRequest,observe},fetch:async(url,init)=>{
  expect(url.origin).toBe('https://api.pandascore.co');expect(url.pathname+url.search).toBe(LIVE_ENDPOINT);
  expect(url.toString()).not.toContain(scheduleToken);expect(init.headers).toMatchObject({Authorization:'Bearer '+scheduleToken});
  return new Response(JSON.stringify([row()]));
 }});
 const result=await client.getRunningMatches();expect(result.source.adapterVersion).toBe('pandascore-running-v1');expect(result.source.payloadSha256).toMatch(/^[a-f0-9]{64}$/);expect(beforeRequest).toHaveBeenCalledTimes(1);expect(observe).toHaveBeenCalledTimes(1);
});
test('429 Retry-After stops bounded attempts and notifies the persistent quota without leaking body',async()=>{
 const observe=vi.fn(async()=>{}),fetch=vi.fn(async()=>new Response(scheduleToken,{status:429,headers:{'Retry-After':'120'}}));
 const client=new PandaScoreLiveClient({apiToken:scheduleToken},{fetch,budget:{beforeRequest:async()=>{},observe}});
 await expect(client.getRunningMatches()).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:120000});expect(fetch).toHaveBeenCalledTimes(1);expect(observe).toHaveBeenCalledWith(429,120000,null);
});
test('503 retries once within budget and malformed/oversized successful bodies are rejected',async()=>{
 let now=Date.now();const fetch=vi.fn().mockResolvedValueOnce(new Response('{}',{status:503})).mockResolvedValueOnce(new Response(JSON.stringify([row()])));
 const client=new PandaScoreLiveClient({apiToken:scheduleToken},{fetch,now:()=>now,sleep:async ms=>{now+=ms;}});expect((await client.getRunningMatches()).source.attempts).toBe(2);
 for(const [body,code] of [['{','source_invalid_json'],['x'.repeat(2*1024*1024+1),'source_response_too_large']]){
  await expect(new PandaScoreLiveClient({apiToken:scheduleToken},{fetch:async()=>new Response(body)}).getRunningMatches()).rejects.toMatchObject({code});
 }
});
