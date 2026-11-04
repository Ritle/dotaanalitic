import {expect,test} from 'vitest';
import {roleEditorHints} from '../src/role-editor';
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
