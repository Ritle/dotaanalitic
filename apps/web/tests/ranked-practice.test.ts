import {afterEach,expect,test,vi} from 'vitest';
import {readRankedPractice} from '../src/ranked-practice';
import {ownerAuth,AuthRequestError} from '../src/auth';
const report={playerId:'20',accountId:'1000',provider:'opendota',snapshotAt:'2026-11-05T00:00:00.000Z',identityRevision:'1',observationIdentityRevision:null,
 identityStatus:'verified',status:'not_loaded',stale:false,reason:'not_loaded',retryAt:null,observationId:null,observation:null,statisticsEnabled:false,heroSummary:null};
afterEach(()=>{vi.restoreAllMocks();ownerAuth.value=null;});
test('ranked client submits a cache-only request with session/CSRF and validates the report',async()=>{
 ownerAuth.value={owner:{id:'11111111-1111-4111-8111-111111111111',login:'synthetic'},expiresAt:'2026-11-07T00:00:00.000Z',csrfToken:'synthetic-csrf'};
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(report))),controller=new AbortController();
 expect(await readRankedPractice('20','opendota',false,controller.signal)).toEqual(report);
 const [path,request]=fetcher.mock.calls[0]!;expect(path).toBe('/api/v1/ranked-practice');expect(request).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'x-csrf-token':'synthetic-csrf'}});
 expect(JSON.parse(String(request?.body))).toEqual({playerId:'20',provider:'opendota',refresh:false});
});
test('mismatched player/provider and malformed response cannot display another report or raw payload',async()=>{
 for(const raw of [{...report,playerId:'21'},{...report,provider:'stratz'},{secret:'synthetic-private-payload'}]){
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(raw)));
  await expect(readRankedPractice('20','opendota',true,new AbortController().signal)).rejects.toThrow('Не удалось прочитать рейтинговую историю.');
  vi.restoreAllMocks();
 }
});
test('expired session retains auth handling while transport failure gets a Russian message',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}',{status:401}));
 await expect(readRankedPractice('20','opendota',false,new AbortController().signal)).rejects.toBeInstanceOf(AuthRequestError);
 expect(ownerAuth.value).toBeNull();vi.restoreAllMocks();
 vi.spyOn(globalThis,'fetch').mockRejectedValue(new TypeError('sensitive transport detail'));
 await expect(readRankedPractice('20','opendota',false,new AbortController().signal)).rejects.toThrow('Не удалось прочитать рейтинговую историю.');
});
