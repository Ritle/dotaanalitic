import {expect,test} from 'vitest';
import {rosterNameCandidates} from '../src/modules/upcoming/roster-name-candidates';
const candidates=(names:string[])=>names.map((name,i)=>({id:String(i+1),name,teamId:null,teamName:null}));
test('short names require whole-token boundaries, including Unicode and numeric nicknames',()=>{
 expect(rosterNameCandidates(candidates(['Thiolicor','Oli','oli','OLIVER']),'Oli').map(p=>p.id)).toEqual(['2','3']);
 expect(rosterNameCandidates(candidates(['Thiolicor','SYN.Oli','Oli~','Oli2']),'Oli').map(p=>p.id)).toEqual(['2','3']);
 expect(rosterNameCandidates(candidates(['SYN.Я','Яблоко']),'Я').map(p=>p.id)).toEqual(['1']);
 expect(rosterNameCandidates(candidates(['123','Team.23','1234']),'23').map(p=>p.id)).toEqual(['2']);
 expect(rosterNameCandidates(candidates(['SYN.a+b','aab']),'a+b').map(p=>p.id)).toEqual(['1']);
 expect(rosterNameCandidates(candidates(['anything']),' ')).toEqual([]);
});
test('aliases and complete normalized nicknames are candidates, never substring history boosts',()=>{
 const rows=[{...candidates(['Different'])[0]!,aliases:['Oli']},...candidates(['Thiolicor']).map(p=>({...p,id:'2',proMaps:1000}))];
 expect(rosterNameCandidates(rows,'ＯＬＩ')).toEqual([rows[0]]);
 expect(rosterNameCandidates(candidates(['N[o]one','SomeoneNoone']),'Noone').map(p=>p.id)).toEqual(['1']);
});
