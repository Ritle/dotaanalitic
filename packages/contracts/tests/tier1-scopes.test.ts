import {expect,test} from 'vitest';
import {Tier1ScopeSchema,Tier1ScopeWriteSchema,tier1ScopeMismatch} from '../src/tier1-scopes.js';
const scope={provider:'opendota',leagueId:'9007199254740993',eventName:'Synthetic main event',fromAt:'2099-01-01T00:00:00.000Z',
 until:'2099-02-01T00:00:00.000Z',tier:1,stage:'main_event',sourceUrl:'https://example.test/synthetic',rationale:'Synthetic explicit owner-reviewed main event'};
test('keeps the runtime scope contract, numeric precision and explicit main-event restrictions',()=>{
 expect(Tier1ScopeSchema.parse(scope).leagueId).toBe(scope.leagueId);
 for(const patch of [{tier:2},{stage:'qualifier'},{provider:'pandascore'},{leagueId:'092'},{leagueId:77},{sourceUrl:'javascript:alert(1)'},{until:scope.fromAt}])expect(Tier1ScopeSchema.safeParse({...scope,...patch}).success).toBe(false);
 expect(Tier1ScopeWriteSchema.safeParse({requestId:'00000000-0000-4000-8000-000000000001',scopeId:'00000000-0000-4000-8000-000000000002',expectedRevision:0,enabled:true,scope,probability:0.5}).success).toBe(false);
 expect(Tier1ScopeWriteSchema.safeParse({requestId:'00000000-0000-4000-8000-000000000001',scopeId:'00000000-0000-4000-8000-000000000002',expectedRevision:0,enabled:true,
  scope:{...scope,sourceUrl:'https://example.test/'+'я'.repeat(9500)}}).success).toBe(false);
});
test('checks canonical external IDs and the half-open event window without classifying names',()=>{
 const s=Tier1ScopeSchema.parse(scope),c={localLeagueId:'11',providerLeagueId:s.leagueId,at:s.fromAt};
 expect(tier1ScopeMismatch(s,c)).toBeNull();expect(tier1ScopeMismatch(s,{...c,at:s.until})).toContain('вне периода');
 expect(tier1ScopeMismatch(s,{...c,providerLeagueId:'11'})).toContain('не совпадает');
 expect(tier1ScopeMismatch(s,{...c,providerLeagueId:null})).toContain('не установлен');
 expect(tier1ScopeMismatch(s,{...c,at:null})).toContain('не указано');
});
