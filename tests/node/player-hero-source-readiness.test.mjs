import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLiveDraft,compareHistoricalStart} from '../../tools/audits/player-hero-source-readiness.mjs';
const live=()=>({matchId:'9007199254740993',leagueId:1,radiantTeamId:'1',direTeamId:'2',gameState:'PRE_GAME',
  gameTime:-30,delay:120,createdDateTime:1700000000,modifiedDateTime:1700000010,
  players:Array.from({length:10},(_,i)=>({steamAccountId:String(i+1),heroId:i+1,playerSlot:i<5?i:128+i-5,isRadiant:i<5}))});
test('full delayed pregame observation is only a candidate, never proof of prestart persistence',()=>{
 const r=inspectLiveDraft(live());assert.equal(r.candidateDraftObservation,true);assert.equal(r.prestartVerified,false);
 assert.equal(r.actualGameplayStartedAt,null);assert.equal(r.primaryEligible,false);assert.equal(r.deployable,false);
});
test('zero delay and negative game time still do not establish UTC gameplay start',()=>{
 const x=live();x.delay=0;assert.equal(inspectLiveDraft(x).actualGameplayStartedAt,null);
});
for(const state of ['HERO_SELECTION','GAME_IN_PROGRESS','POST_GAME','UNKNOWN'])test('phase '+state+' cannot qualify as final pregame draft',()=>{
 const x=live();x.gameState=state;assert.equal(inspectLiveDraft(x).candidateDraftObservation,false);
});
test('missing and duplicate accounts, heroes and inconsistent sides are explicit failures',()=>{
 const x=live();x.players[0].steamAccountId=null;x.players[1].heroId=x.players[2].heroId;x.players[3].isRadiant=false;
 assert.deepEqual(inspectLiveDraft(x).reasons,['TEN_DISTINCT_ACCOUNTS_MISSING','TEN_DISTINCT_HEROES_MISSING','MAP_SIDES_UNVERIFIED']);
});
test('player array order does not determine side; numeric IDs remain exact strings',()=>{
 const x=live();x.players.reverse();assert.equal(inspectLiveDraft(x).candidateDraftObservation,true);
 assert.equal(inspectLiveDraft(x).matchId,'9007199254740993');
 x.matchId=9007199254740992;assert.throws(()=>inspectLiveDraft(x));
});
test('agreeing postgame timestamps cannot prove early availability or gameplay semantics',()=>{
 const x={matchId:'1',openDotaStartUs:'1700000000000000',stratzStartSeconds:1700000000,
   stratzFetchedAt:'2023-11-15T00:00:00.000Z',stratzKnownAt:null};
 const r=compareHistoricalStart(x);assert(r.startsAgree);assert.equal(r.receiptBeforeProviderStart,false);
 assert.equal(r.clockSemanticsVerified,false);assert.equal(r.prestartDraftAvailabilityVerified,false);
 x.openDotaStartUs='1700000000000001';assert.equal(compareHistoricalStart(x).startsAgree,false);
});
test('a receipt at the provider start is not earlier; even an early receipt is not phase proof',()=>{
 const x={matchId:'1',openDotaStartUs:'1700000000000000',stratzStartSeconds:1700000000,
   stratzFetchedAt:new Date(1700000000000).toISOString(),stratzKnownAt:null};
 assert.equal(compareHistoricalStart(x).receiptBeforeProviderStart,false);
 x.stratzFetchedAt=new Date(1699999999999).toISOString();
 const r=compareHistoricalStart(x);assert.equal(r.receiptBeforeProviderStart,true);assert.equal(r.clockSemanticsVerified,false);
});
