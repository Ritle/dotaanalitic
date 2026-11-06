import {afterEach,expect,test,vi} from 'vitest';
import {readRankedContext} from '../src/ranked-context';
import {ownerAuth,AuthRequestError} from '../src/auth';
const parent='11111111-1111-4111-8111-111111111111',report={playerId:'1',parentObservationId:parent,accountId:'1000',identityRevision:'1',provider:'stratz',policyVersion:'stratz-known-ranked-map-v1',snapshotAt:'2026-11-06T00:00:00.000Z',status:'unavailable',reason:'not_configured',retryAt:null,parentFromAt:null,parentCutoffAt:null,parentGames:0,selectedMaps:0,matchedMaps:0,maps:[]};
afterEach(()=>{vi.restoreAllMocks();ownerAuth.value=null;});
test('context client binds response to requested player and parent and defaults to cache-only payload',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(report))),controller=new AbortController();
 expect(await readRankedContext('1',parent,false,controller.signal)).toEqual(report);expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/ranked-practice/context');
 expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({playerId:'1',parentObservationId:parent,refresh:false});expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal});
});
test('other parent/player and raw provider payload cannot replace this context',async()=>{
 for(const raw of [{...report,playerId:'2'},{...report,parentObservationId:'22222222-2222-4222-8222-222222222222'},{secret:'synthetic-sensitive'}]){
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(raw)));await expect(readRankedContext('1',parent,true,new AbortController().signal)).rejects.toThrow('Не удалось прочитать дополнение STRATZ.');vi.restoreAllMocks();
 }
});
test('expired session and failed transport preserve safe auth/error behaviour',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}',{status:401}));await expect(readRankedContext('1',parent,false,new AbortController().signal)).rejects.toBeInstanceOf(AuthRequestError);expect(ownerAuth.value).toBeNull();vi.restoreAllMocks();
 vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('private transport'));await expect(readRankedContext('1',parent,false,new AbortController().signal)).rejects.toThrow('Не удалось прочитать дополнение STRATZ.');
});
