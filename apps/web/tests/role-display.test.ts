import {test,expect} from 'vitest';
import {roleSortedRows} from '../src/role-display';
import {roleName} from '../src/role-suggestions';
test('review orders roles without changing player identity, source order, unknown roles or bound row references',()=>{
 const rows=[{id:'a',role:5,standin:true},{id:'unknown',role:null,standin:false},{id:'b',role:1,standin:false},{id:'c',role:3,standin:false},{id:'d',role:2,standin:false},{id:'e',role:4,standin:false},{id:'conflict',role:1,standin:false}];
 const view=roleSortedRows(rows,p=>p.role);
 expect(view.map(p=>p.id)).toEqual(['b','conflict','d','c','e','a','unknown']);expect(rows.map(p=>p.id)).toEqual(['a','unknown','b','c','d','e','conflict']);
 expect(view.find(p=>p.id==='a')).toBe(rows[0]);expect(view.find(p=>p.id==='a')?.standin).toBe(true);expect(view.at(-1)?.role).toBeNull();
 view[0]!.standin=true;expect(rows[2]!.standin).toBe(true);
 expect([1,2,3,4,5].map(roleName)).toEqual(['Carry','Mid','Offlane','SemiSupport','Hard Support']);
});
