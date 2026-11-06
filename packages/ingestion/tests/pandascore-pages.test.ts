import {test,expect} from 'vitest';
import {PandaScoreClient} from '../src/pandascore/client.js';
test('requests exactly the selected bounded page and rejects invalid pages before transport',async()=>{
 const urls:string[]=[],client=new PandaScoreClient({apiToken:'synthetic-page-token'},{fetch:async url=>{urls.push(url.pathname+url.search);return new Response('[]');},sleep:async()=>{}});
 for(const page of [0,-1,51,1.5,NaN,Infinity])expect(()=>client.getUpcomingMatches(page)).toThrow('invalid_configuration');
 expect(urls).toEqual([]);
 const last=await client.getUpcomingMatches(50);expect(last.source.endpoint).toBe('/dota2/matches/upcoming?sort=scheduled_at,id&page=50&per_page=20');
 const first=await client.getUpcomingMatches();expect(first.source.endpoint).toBe('/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20');
 expect(urls).toEqual([last.source.endpoint,first.source.endpoint]);expect(last.data).toEqual([]);
});
