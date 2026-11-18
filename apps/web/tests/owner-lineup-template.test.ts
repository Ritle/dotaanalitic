import {test,expect} from 'vitest';
import {templateLineup,applyOwnerTemplate,sameTemplateRoles} from '../src/owner-lineup-template';
const rows=()=>Array.from({length:5},(_,i)=>({playerId:String(9007199254741000n+BigInt(i)),rolePos:i+1,isStandin:i===0}));
const template=()=>({teamId:'9007199254740993',revision:1,lineup:rows().map((p,i)=>({playerId:p.playerId,rolePos:5-i})).reverse(),confirmedBy:{id:'123e4567-e89b-42d3-a456-426614174000',login:'synthetic-owner'},confirmedAt:'2026-11-11T00:00:00.000Z'});
test('owner roles follow exact bigint player IDs, preserving card order and match-specific stand-ins',()=>{
 const before=rows(),r=applyOwnerTemplate(template().teamId,before,template())!;expect(r.map(p=>p.rolePos)).toEqual([5,4,3,2,1]);expect(r.map(p=>p.playerId)).toEqual(before.map(p=>p.playerId));expect(r[0]!.isStandin).toBe(true);expect(rows()).toEqual(before);
});
test('another team or any replacement never inherits the old five assignments',()=>{
 expect(applyOwnerTemplate('9007199254740992',rows(),template())).toBeNull();expect(applyOwnerTemplate(template().teamId,rows().map((p,i)=>i?p:{...p,playerId:'77'}),template())).toBeNull();expect(applyOwnerTemplate(template().teamId,rows(),null)).toBeNull();
});
test('partial choices, duplicate players/roles and invalid roles cannot create or apply a template',()=>{
 expect(templateLineup(rows().slice(1))).toBeNull();for(const bad of [rows().map(p=>({...p,playerId:'1'})),rows().map(p=>({...p,rolePos:1})),rows().map((p,i)=>i?p:{...p,rolePos:6})])expect(templateLineup(bad)).toBeNull();
 expect(applyOwnerTemplate(template().teamId,rows(),{...template(),lineup:template().lineup.map((p,i)=>i?p:{...p,rolePos:0})})).toBeNull();
});
test('unchanged roles need no second write; a manual correction is detected independently of response order',()=>{
 const t=template(),applied=applyOwnerTemplate(t.teamId,rows(),t)!;expect(sameTemplateRoles(t.teamId,applied,t)).toBe(true);expect(sameTemplateRoles(t.teamId,rows(),t)).toBe(false);expect(templateLineup(applied)?.[0]).toEqual({playerId:rows()[0]!.playerId,rolePos:5});
});
