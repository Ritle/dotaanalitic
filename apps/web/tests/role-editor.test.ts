import {expect,test} from 'vitest';
import {roleEditorHints,rolePlayerName,rolePlayerLabel,selectedRolePlayerLabel} from '../src/role-editor';
import type {RoleProfilesReport} from '@dota/contracts';
type Candidate=RoleProfilesReport['players'][number]['candidates'][number];
const candidate=(source:Candidate['source'],roles:number[],eligible=true):Candidate=>({source,roles,eligible,reason:eligible?null:'SOURCE_NOT_FRESH'});
const players=()=>Array.from({length:5},(_,i)=>({playerId:String(9007199254740993n+BigInt(i)),identityStatus:'verified' as const,
  candidates:[candidate('pandascore',[i+1])]}));
test('one source per player is enough for all five roles, retaining BIGINT-safe identities',()=>{
 const r=roleEditorHints(players());expect(r.canArrange).toBe(true);expect(r.players.map(p=>p.rolePos)).toEqual([1,2,3,4,5]);
 expect(r.players[0]).toMatchObject({playerId:'9007199254740993',editorSource:'pandascore',editorConflict:false});
});
test('Panda wins disagreements with STRATZ and history; input evidence stays immutable',()=>{
 const input=players();input[0]!.candidates.push(candidate('stratz',[2]),candidate('pro_history',[3]));const before=JSON.stringify(input);
 const r=roleEditorHints(input);expect(r.canArrange).toBe(true);expect(r.players[0]).toMatchObject({rolePos:1,editorSource:'pandascore',editorConflict:true});
 expect(JSON.stringify(input)).toBe(before);
});
test('unavailable Panda is excluded; STRATZ takes precedence over history',()=>{
 const input=players();input[0]!.candidates=[candidate('pandascore',[5],false),candidate('stratz',[1]),candidate('pro_history',[2])];
 expect(roleEditorHints(input).players[0]).toMatchObject({rolePos:1,editorSource:'stratz',editorConflict:true});
});
test('history alone may arrange the editor without API agreement',()=>{
 const input=players().map((p,i)=>({...p,candidates:[candidate('pro_history',[i+1])]}));
 expect(roleEditorHints(input).canArrange).toBe(true);expect(roleEditorHints(input).players.every(p=>p.editorSource==='pro_history')).toBe(true);
});
test('mixed roles fall back to an unambiguous source, never an arbitrary member of the mixed list',()=>{
 const input=players();input[3]!.candidates=[candidate('pandascore',[4,5]),candidate('stratz',[4])];
 expect(roleEditorHints(input).players[3]).toMatchObject({rolePos:4,editorSource:'stratz',editorConflict:false});
 input[3]!.candidates.pop();expect(roleEditorHints(input).players[3]).toMatchObject({rolePos:null,editorSource:null,editorAmbiguous:true});
});
test('duplicates are marked and do not cause assignment of leftover positions',()=>{
 const input=players();input[4]!.candidates=[candidate('pandascore',[1])];const r=roleEditorHints(input);
 expect(r.canArrange).toBe(false);expect(r.hasDuplicates).toBe(true);expect(r.players.filter(p=>p.editorDuplicate).map(p=>p.playerId)).toEqual([input[0]!.playerId,input[4]!.playerId]);
 expect(r.players[4]!.rolePos).toBe(1);
});
test('unresolved/conflicting identities, empty or ineligible candidates stay unknown',()=>{
 for(const identityStatus of ['unknown','conflict'] as const){const r=roleEditorHints(players().map(p=>({...p,identityStatus})));expect(r.canArrange).toBe(false);expect(r.players.every(p=>p.rolePos===null)).toBe(true);}
 for(const candidates of [[],[candidate('pandascore',[])],[candidate('stratz',[1],false)]]){
  const r=roleEditorHints(players().map(p=>({...p,candidates})));expect(r.canArrange).toBe(false);expect(r.players.every(p=>p.rolePos===null)).toBe(true);
 }
});
test('a partial roster or repeated identity is not a five-player arrangement',()=>{
 expect(roleEditorHints(players().slice(1)).canArrange).toBe(false);
 const input=players();input[1]!.playerId=input[0]!.playerId;expect(roleEditorHints(input).canArrange).toBe(false);
});
const nameReport=():Pick<RoleProfilesReport,'binding'|'sources'>=>({binding:{teamId:'9007199254740993',revision:1,recordedAt:null,
 binding:{stratzTeamId:null,pandaTournamentId:'55',pandaTeamId:'88',pandaPlayers:[{playerId:'9007199254740994',providerPlayerId:'2001'}]}},
 sources:[{provider:'pandascore',sourceKey:'pandascore:roster:55',status:'ready',reason:null,fetchedAt:'2026-11-04T00:00:00.000Z',
  observation:{provider:'pandascore',sourceKey:'pandascore:roster:55',knownAt:null,eventAt:null,fetchedAt:'2026-11-04T00:00:00.000Z',payloadSha256:'a'.repeat(64),
   players:[{accountId:null,providerPlayerId:'2001',providerTeamId:'88',name:'Synthetic current nickname',roles:[3]}]}}]});
const namePlayer=()=>({playerId:'9007199254740994',accountIds:['123'],identityStatus:'verified' as const});
test('role labels follow an explicit numeric Panda player/team/tournament binding',()=>{
 const report=nameReport(),before=JSON.stringify(report);expect(rolePlayerName(report,namePlayer())).toBe('Synthetic current nickname');expect(JSON.stringify(report)).toBe(before);
 report.sources[0]!.observation!.players[0]!.providerTeamId='89';expect(rolePlayerName(report,namePlayer())).toBeNull();
 report.sources[0]!.observation!.players[0]!.providerTeamId='88';report.sources[0]!.sourceKey='pandascore:roster:56';expect(rolePlayerName(report,namePlayer())).toBeNull();
});
test('namesakes, duplicate rows, stale data and unresolved identities do not produce a player label',()=>{
 const report=nameReport();report.sources[0]!.observation!.players[0]!.providerPlayerId='2002';expect(rolePlayerName(report,namePlayer())).toBeNull();
 report.sources[0]!.observation!.players[0]!.providerPlayerId='2001';report.sources[0]!.observation!.players.push({...report.sources[0]!.observation!.players[0]!});expect(rolePlayerName(report,namePlayer())).toBeNull();
 report.sources[0]!.observation!.players.pop();report.sources[0]!.status='stale';expect(rolePlayerName(report,namePlayer())).toBeNull();
 report.sources[0]!.status='ready';expect(rolePlayerName(report,{...namePlayer(),identityStatus:'conflict'})).toBeNull();
});
test('STRATZ fallback labels only its verified numeric account, without choosing by nickname',()=>{
 const report=nameReport(),source=report.sources[0]!;source.provider='stratz';source.sourceKey='stratz:player:123';source.observation!.provider='stratz';source.observation!.sourceKey=source.sourceKey;
 source.observation!.players=[{accountId:'123',providerPlayerId:'123',providerTeamId:null,name:'Synthetic Steam nickname',roles:[]}];
 expect(rolePlayerName(report,namePlayer())).toBe('Synthetic Steam nickname');source.observation!.players[0]!.accountId='124';expect(rolePlayerName(report,namePlayer())).toBeNull();
});
test('selected labels identify the chosen catalogue row without resolving missing or conflicting evidence',()=>{
 const report=nameReport();report.sources[0]!.status='stale';
 const player={...namePlayer(),identityStatus:'conflict' as const},before=JSON.stringify({report,player});
 expect(rolePlayerLabel(report,player,'Saved player')).toBe(`Выбранный игрок: Saved player · ID ${player.playerId}`);
 expect(rolePlayerName(report,player)).toBeNull();expect(JSON.stringify({report,player})).toBe(before);
 expect(selectedRolePlayerLabel('9007199254740993','  ')).toBe('Игрок 9007199254740993');
 expect(selectedRolePlayerLabel('59',String.fromCodePoint(0x20e4,0x20df))).toBe('Игрок 59');
 report.sources[0]!.status='ready';report.sources[0]!.observation!.players[0]!.name=String.fromCodePoint(0x20e4,0x20df);
 expect(rolePlayerLabel(report,namePlayer(),'Readable selected name')).toBe(`Выбранный игрок: Readable selected name · ID ${namePlayer().playerId}`);
});
test('a fresh verified provider alias takes precedence over the selected display name',()=>{
 const report=nameReport();report.sources[0]!.observation!.players[0]!.name='Fresh provider alias';
 expect(rolePlayerLabel(report,namePlayer(),'Saved player')).toBe(`Fresh provider alias · ID ${namePlayer().playerId}`);
});
