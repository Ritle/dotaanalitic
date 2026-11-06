import {it,expect} from 'vitest';
import {prepareStoredHistoryProjection} from '../src/history-resume-projection.js';
import {PlayerHistoryReportSchema} from '@dota/contracts';
const ref=(id:string,endpoint:string,payload:unknown)=>({id,endpoint,payload,payloadSha256:'a'.repeat(64),fetchedAt:'2026-01-01T01:00:00.000Z'});
const input=()=>({matchId:'9001',receiptId:'1',payloadSha256:'b'.repeat(64),fetchedAt:'2026-01-01T01:00:00.000Z',eventAt:'2026-01-01T00:00:00.000Z',isPro:true,status:'accepted',
 projection:{match_id:'9001',start_time:1767225600,duration:600,radiant_win:true,leagueid:'7',players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,account_id:String(1001+i),hero_id:i+1}))},
 heroes:ref('2','/heroes',Array.from({length:10},(_,i)=>({id:i+1,name:'synthetic_'+i,localized_name:'Synthetic '+i}))),
 leagues:ref('3','/leagues',[{leagueid:'7',name:'Synthetic league',tier:'professional'}])});
it('marks a reconstructed projection separately from original response bytes and retains parent clocks',()=>{
 const r=prepareStoredHistoryProjection(input(),'2026-01-02T00:00:00.000Z');
 expect(r.match.source.adapterVersion).toBe('stored-history-projection-v1');expect(r.match.source.attempts).toBe(0);
 expect(r.match.source.payloadSha256).not.toBe(input().payloadSha256);
 expect(r.manifest).toMatchObject({kind:'stored_receipt_projection',parentReceiptId:'1',parentFetchedAt:input().fetchedAt,parentPayloadSha256:input().payloadSha256,derivedAt:'2026-01-02T00:00:00.000Z'});
 expect(JSON.parse(r.match.rawBody)._history_projection.parentReceiptId).toBe('1');
 expect(r.heroes.source.payloadSha256).not.toBe(input().heroes.payloadSha256);
});
it('rejects mismatched map IDs, future parents and invalid receipt states',()=>{
 expect(()=>prepareStoredHistoryProjection({...input(),matchId:'9002'},'2026-01-02T00:00:00.000Z')).toThrow();
 expect(()=>prepareStoredHistoryProjection(input(),'2025-12-31T00:00:00.000Z')).toThrow();
 expect(()=>prepareStoredHistoryProjection({...input(),status:'conflict'},'2026-01-02T00:00:00.000Z')).toThrow();
});
it('rejects non-pro reference classifications and incomplete/mismatched native participation',()=>{
 const a=input();a.leagues.payload[0]!.tier='excluded';expect(()=>prepareStoredHistoryProjection(a,'2026-01-02T00:00:00.000Z')).toThrow();
 const b=input();b.projection.players[9]!.player_slot=0;expect(()=>prepareStoredHistoryProjection(b,'2026-01-02T00:00:00.000Z')).toThrow();
 const c=input();c.projection.players.pop();expect(()=>prepareStoredHistoryProjection(c,'2026-01-02T00:00:00.000Z')).toThrow();
});
it('rejects a reference with the wrong endpoint or unavailable original result time',()=>{
 const a=input();a.heroes.endpoint='/leagues';expect(()=>prepareStoredHistoryProjection(a,'2026-01-02T00:00:00.000Z')).toThrow();
 const b=input();b.fetchedAt='2026-01-01T00:01:00.000Z';expect(()=>prepareStoredHistoryProjection(b,'2026-01-02T00:00:00.000Z')).toThrow();
});
it('keeps old report policies valid and requires explicit v4 resume provenance',()=>{
 const report={policyVersion:'selected-player-history-v3',cutoffAt:'2026-01-01T01:00:00.000Z',fromAt:'2026-01-01T00:00:00.000Z',fetchedAt:'2026-01-01T01:00:00.000Z',selected:0,accepted:0,duplicates:0,excluded:0,failed:0,conflicts:0,
  players:Array.from({length:5},(_,i)=>({playerId:String(i+1),accountId:String(1001+i),discovered:0,selected:0,accepted:0})),maps:[]};
 expect(PlayerHistoryReportSchema.safeParse(report).success).toBe(true);
 expect(PlayerHistoryReportSchema.safeParse({...report,policyVersion:'selected-player-history-v4'}).success).toBe(false);
 expect(PlayerHistoryReportSchema.safeParse({...report,policyVersion:'selected-player-history-v4',operation:'evidence_resume',parentRunId:'10000000-0000-4000-8000-000000000001'}).success).toBe(true);
 expect(PlayerHistoryReportSchema.safeParse({...report,operation:'evidence_resume'}).success).toBe(false);
});
