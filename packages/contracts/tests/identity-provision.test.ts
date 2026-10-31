import {it,expect} from 'vitest';
import {ReviewedAccountBatchSchema} from '../src/identity-provision.js';
const batch=()=>({schemaVersion:1,policyVersion:'reviewed-single-account-v1',reviewedAt:'2026-10-31T00:00:00.000Z',
  source:{reportSha256:'a'.repeat(64),mapSha256:'b'.repeat(64),payloadSha256:'c'.repeat(64),projectionSha256:'d'.repeat(64),
    archiveUrl:'https://web.archive.org/web/20230411210628id_/https://api.opendota.com/api/proPlayers?',
    knownAt:'2023-04-11T21:06:28.000Z',fetchedAt:'2026-10-30T00:00:00.000Z'},
  accounts:[{accountId:'101',steam64:'76561197960265829',alias:'Synthetic alias'}]});
it('preserves numeric account and independent clocks in a bounded reviewed batch',()=>{
  expect(ReviewedAccountBatchSchema.parse(batch())).toEqual(batch());
});
it('rejects duplicate/unsafe accounts and Steam64 mismatches without numeric rounding',()=>{
  const b=batch();b.accounts.push({...b.accounts[0]!});expect(()=>ReviewedAccountBatchSchema.parse(b)).toThrow();
  for(const change of [{accountId:'0'},{accountId:'4294967296'},{steam64:'76561197960265830'},{steam64:76561197960265829}])
    expect(()=>ReviewedAccountBatchSchema.parse({...batch(),accounts:[{...batch().accounts[0],...change}]})).toThrow();
});
it('rejects unreviewed clocks, unknown metadata, missing alias and arbitrary source URL',()=>{
  for(const patch of [{knownAt:'2027-01-01T00:00:00.000Z'},{fetchedAt:'2027-01-01T00:00:00.000Z'},
    {archiveUrl:'https://example.invalid'},{payloadSha256:'invalid'}])
    expect(()=>ReviewedAccountBatchSchema.parse({...batch(),source:{...batch().source,...patch}})).toThrow();
  expect(()=>ReviewedAccountBatchSchema.parse({...batch(),is_pro:true})).toThrow();
  expect(()=>ReviewedAccountBatchSchema.parse({...batch(),accounts:[{...batch().accounts[0],alias:''}]})).toThrow();
});
