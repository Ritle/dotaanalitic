import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {sql,IdentityRepository,PlayerHistoryRepository,readAccountEvidence,resolveIdentity} from '@dota/db';
import {createPlayerHistoryQueue,enqueuePlayerHistory,executePlayerHistory,enrichHistoryEvidence,OpenDotaClient,PLAYER_HISTORY_QUEUE} from '@dota/ingestion';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {syntheticPlayerHistory} from '../../../tests/helpers/player-history.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,boss:Awaited<ReturnType<typeof createPlayerHistoryQueue>>,owner:string;const ids:string[]=[],calls:string[]=[];
beforeAll(async()=>{database=await testDatabase();owner=(await new AuthService(database.db).provision('synthetic-enrichment',randomBytes(24).toString('base64url'))).id;
 for(let i=0;i<5;i++){const id=(await sql<{id:string}>`INSERT INTO players(nickname) VALUES(${'Synthetic '+i}) RETURNING id`.execute(database.db)).rows[0]!.id;ids.push(id);
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:id,externalAccountId:String(1001+i),provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),evidenceRef:'synthetic:enrichment',source:'synthetic'});}
 boss=await createPlayerHistoryQueue(database.url);
},30000);
afterAll(async()=>{await boss?.stop({graceful:true,timeout:10000});await database?.close();},30000);
it('enriches all participants and series, replays the original capture without duplicate detail calls, and reuses verified identities',async()=>{
 const repo=new PlayerHistoryRepository(database.db),bindings=(await repo.bindings(ids))!;
 const id=await enqueuePlayerHistory(boss,database.db,owner,bindings);
 await executePlayerHistory(database.db,id,1,syntheticPlayerHistory({enrichment:true,onCall:p=>calls.push(p)}));await boss.cancel(PLAYER_HISTORY_QUEUE,id);
 const row=await repo.get(id);expect(row?.status).toBe('completed');expect(row?.report).toMatchObject({policyVersion:'selected-player-history-v3',accepted:2,enrichment:{accountsVerified:5,seriesCreated:1,replayedMaps:2,unresolvedAccounts:[]}});
 expect(calls.filter(p=>p.includes('/matches/'))).toHaveLength(2);expect(calls.filter(p=>p.endsWith('/proPlayers'))).toHaveLength(1);
 expect((await sql`SELECT count(*)::int n FROM match_players WHERE player_id IS NOT NULL`.execute(database.db)).rows[0]).toEqual({n:20});
 expect((await sql`SELECT count(*)::int n FROM matches WHERE series_id IS NOT NULL`.execute(database.db)).rows[0]).toEqual({n:2});
 expect((await sql`SELECT count(*)::int n FROM match_field_observations WHERE known_at IS NOT NULL`.execute(database.db)).rows[0]).toEqual({n:0});
 const counts=(await sql`SELECT (SELECT count(*)::int FROM player_account_evidence) accounts,(SELECT count(*)::int FROM series) series`.execute(database.db)).rows[0];
 const repeat=await enrichHistoryEvidence(database.db,syntheticPlayerHistory({enrichment:true,onCall:p=>calls.push(p)}),Array.from({length:10},(_,i)=>String(1001+i)),['90088'],async()=>true);
 expect(repeat.accountsVerified).toBe(0);expect(repeat.seriesCreated).toBe(0);expect(calls.filter(p=>p.endsWith('/proPlayers'))).toHaveLength(1);
 expect((await sql`SELECT (SELECT count(*)::int FROM player_account_evidence) accounts,(SELECT count(*)::int FROM series) series`.execute(database.db)).rows[0]).toEqual(counts);
});
it('preserves conflicting identities and stops stale work before provider calls',async()=>{
 const {observationId:_,...proof}=(await readAccountEvidence(database.db,['1006'])).find(p=>p.status==='verified')!;
 await new IdentityRepository(database.db).appendAccountEvidence({...proof,status:'rejected',evidenceRef:'synthetic:rejected'});
 let requests=0;const provider=syntheticPlayerHistory({enrichment:true,onCall:()=>requests++});
 await expect(enrichHistoryEvidence(database.db,provider,['1006'],[],async()=>false)).rejects.toThrow('player_history_stale_attempt');expect(requests).toBe(0);
 const result=await enrichHistoryEvidence(database.db,provider,['1006'],[],async()=>true);
 expect(result.accountsVerified).toBe(0);expect(result.unresolvedAccounts).toEqual(['1006']);expect(result.reasons).toContain('IDENTITY_CONFLICT');
 expect(requests).toBe(0);
 expect(resolveIdentity(await readAccountEvidence(database.db,['1006']),'1006',null).status).toBe('conflict');
});
it('bounds profile fallbacks and shares negative cache without inventing private accounts',async()=>{
 let requests=0;const client=new OpenDotaClient({attempts:1,maxRequests:25},{sleep:async()=>undefined,fetch:async()=>{requests++;return new Response(JSON.stringify({profile:null}));}});
 const provider={...syntheticPlayerHistory({enrichment:true}),getPlayer:(id:string)=>client.getPlayer(id)},accounts=Array.from({length:25},(_,i)=>String(5001+i));
 const first=await enrichHistoryEvidence(database.db,provider,accounts,[],async()=>true);
 expect(first.profilesRequested).toBe(20);expect(requests).toBe(20);expect(first.unresolvedAccounts).toHaveLength(25);expect(first.accountsVerified).toBe(0);expect(first.reasons).toContain('ENRICHMENT_BOUND_REACHED');
 await enrichHistoryEvidence(database.db,provider,accounts,[],async()=>true);expect(requests).toBe(20);
 expect(await readAccountEvidence(database.db,accounts)).toHaveLength(0);
});
it('uses a numeric profile outside the registry with its real observation time',async()=>{
 let requests=0;const client=new OpenDotaClient({attempts:1,maxRequests:2},{sleep:async()=>undefined,fetch:async()=>{requests++;return new Response(JSON.stringify({profile:{account_id:6001,steamid:String(76561197960265728n+6001n),personaname:'Synthetic renamed'}}));}});
 const result=await enrichHistoryEvidence(database.db,{...syntheticPlayerHistory({enrichment:true}),getPlayer:id=>client.getPlayer(id)},['6001'],[],async()=>true);
 expect(result.accountsVerified).toBe(1);expect(result.unresolvedAccounts).toEqual([]);expect(requests).toBe(1);
 const proof=(await readAccountEvidence(database.db,['6001']))[0]!;expect(proof.status).toBe('verified');expect(proof.eventAt).toBeNull();expect(proof.knownAt).toBe(proof.fetchedAt);expect(proof.source).toContain('/players/6001');
});
