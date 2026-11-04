import {expect,test} from 'vitest';
import {upcomingParticipants,upcomingParticipantKey,upcomingProviderForSlot} from '../src/upcoming-participants';
import {syntheticTargetMatch} from '../../../tests/helpers/schedule-target';
const team={providerTeamId:'9007199254740993',name:'CyberHero'};
test('one known participant has an explicit missing opponent instead of a complete-looking match',()=>{
 const m=syntheticTargetMatch({opponents:[team]}),r=upcomingParticipants(m);
 expect(r.complete).toBe(false);expect(r.label).toBe('CyberHero — Соперник не указан');expect(r.message).toContain('только одна команда');
 expect(r.teams).toEqual([team]);expect(upcomingProviderForSlot(m,'A')).toBeUndefined();expect(upcomingProviderForSlot(m,'B')).toBeUndefined();
});
test('no participants never reuses a possibly stale source match name as a known pairing',()=>{
 const r=upcomingParticipants(syntheticTargetMatch({name:'Old A vs B',opponents:[]}));
 expect(r.label).toBe('Участники не указаны');expect(r.complete).toBe(false);expect(r.teams).toEqual([]);
});
test('two distinct IDs with unknown or identical names are still known teams; IDs stay strings',()=>{
 const m=syntheticTargetMatch({opponents:[{...team,name:null},{providerTeamId:'9007199254740994',name:null}]});
 expect(upcomingParticipants(m).complete).toBe(true);expect(upcomingParticipants(m).label).toContain('9007199254740993');
 expect(upcomingProviderForSlot(m,'B')).toBe('9007199254740994');
 expect(upcomingParticipants(syntheticTargetMatch({opponents:[team,{...team,providerTeamId:'9007199254740994'}]})).complete).toBe(true);
});
test('duplicate provider IDs are incomplete even if the source supplies two names',()=>{
 const m=syntheticTargetMatch({opponents:[team,{...team,name:'Other name'}]});expect(upcomingParticipants(m).complete).toBe(false);
 expect(upcomingParticipants(m).teams).toHaveLength(1);expect(upcomingProviderForSlot(m,'A')).toBeUndefined();
});
test('participant changes including order reset form identity; display-name corrections do not',()=>{
 const one=syntheticTargetMatch({opponents:[team]}),two={...one,opponents:[team,{providerTeamId:'75',name:'Rival'}]};
 expect(upcomingParticipantKey(one)).not.toBe(upcomingParticipantKey(two));
 expect(upcomingParticipantKey(two)).not.toBe(upcomingParticipantKey({...two,opponents:[...two.opponents].reverse()}));
 expect(upcomingParticipantKey(one)).toBe(upcomingParticipantKey({...one,opponents:[{...team,name:'Corrected spelling'}]}));
});
