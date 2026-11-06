import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {historyAccountReviews,historyParticipantAccounts} from '../src/history-enrichment.js';
const observation=(rows:unknown[],endpoint='/proPlayers')=>{const rawBody=JSON.stringify(rows);return {rawBody,source:{endpoint,fetchedAt:'2026-01-01T00:00:00.000Z',payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
const player=(id:number)=>({account_id:id,steamid:String(76561197960265728n+BigInt(id)),name:'same nickname'});
describe('history enrichment numeric evidence',()=>{
 it('deduplicates native participants across maps, excludes invalid accounts and uses numeric ordering',()=>{
  expect(historyParticipantAccounts([{players:[{account_id:'22'},{account_id:'3'},{account_id:null}]},{players:[{account_id:'22'},{account_id:'4294967295'}]}])).toEqual(['3','22']);
 });
 it('binds different accounts with identical names separately and leaves absent accounts unresolved',()=>{
  const result=historyAccountReviews(observation([player(3),player(22)]),['3','22','99'],'2026-01-02T00:00:00.000Z');
  expect(result.reviews.map(r=>r.accounts[0]!.accountId)).toEqual(['3','22']);expect(result.unresolved).toEqual(['99']);
  expect(result.reviews[0]!.source.knownAt).toBe('2026-01-01T00:00:00.000Z');
 });
 it('does not choose between duplicate numeric registry rows',()=>{
  expect(()=>historyAccountReviews(observation([player(3),player(3)]),['3'],'2026-01-02T00:00:00.000Z')).toThrow();
 });
 it('rejects changed hash, wrong endpoint and future evidence',()=>{
  const o=observation([player(3)]);expect(()=>historyAccountReviews({...o,rawBody:'[]'},['3'],'2026-01-02T00:00:00.000Z')).toThrow();
  expect(()=>historyAccountReviews(observation([player(3)],'/players/3'),['3'],'2026-01-02T00:00:00.000Z')).toThrow();
  expect(()=>historyAccountReviews(o,['3'],'2025-01-02T00:00:00.000Z')).toThrow();
 });
 it('refuses a numeric Steam32/Steam64 mismatch without accepting other evidence for that row',()=>{
  const r=historyAccountReviews(observation([{...player(3),steamid:player(22).steamid}]),['3'],'2026-01-02T00:00:00.000Z');expect(r.reviews).toEqual([]);expect(r.unresolved).toEqual(['3']);
 });
});
