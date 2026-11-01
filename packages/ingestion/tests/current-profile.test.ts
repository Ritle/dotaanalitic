import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {prepareCurrentProfile} from '../src/opendota/current-profile.js';
const time='2026-01-01T00:00:00.000Z',selection={accountIds:['101'],reviewedAt:'2026-01-02T00:00:00.000Z'};
const profile={account_id:101,steamid:'76561197960265829',name:null,personaname:'Synthetic display alias'};
function capture(value:unknown=profile){const rawBody=JSON.stringify({profile:value});return {schemaVersion:1,mode:'current_profile_capture',
 accountId:'101',observation:{rawBody,source:{provider:'opendota',endpoint:'/players/101',knownAt:null,fetchedAt:time,
 payloadSha256:createHash('sha256').update(rawBody).digest('hex')}}};}
it('uses supplied numeric profile IDs and display alias without asserting professional status or membership',()=>{
 const r=prepareCurrentProfile(capture(),'a'.repeat(64),selection);
 expect(r.review).toMatchObject({policyVersion:'reviewed-current-profile-v1',source:{url:'https://api.opendota.com/api/players/101',knownAt:time,fetchedAt:time},
 accounts:[{accountId:'101',steam64:profile.steamid,alias:profile.personaname}]});
 expect(r.warnings).toContain('PROFILE_IS_NOT_PRO_OR_LINEUP_PROOF');expect(r.review).not.toHaveProperty('teams');
});
it.each([null,{...profile,steamid:null},{...profile,steamid:'76561197960265728'},{...profile,name:null,personaname:''}])('rejects incomplete or inconsistent profile %j',p=>{
 expect(()=>prepareCurrentProfile(capture(p),'a'.repeat(64),selection)).toThrow();
});
it('refuses account/path/selection mismatches and more than one selected ID',()=>{
 expect(()=>prepareCurrentProfile(capture({...profile,account_id:102}),'a'.repeat(64),selection)).toThrow();
 const c=capture();c.observation.source.endpoint='/players/102';expect(()=>prepareCurrentProfile(c,'a'.repeat(64),selection)).toThrow();
 for(const ids of [['102'],['101','102']])expect(()=>prepareCurrentProfile(capture(),'a'.repeat(64),{...selection,accountIds:ids})).toThrow();
});
it('rejects altered raw bytes, a registry masquerading as a profile and backdated review',()=>{
 const c=capture();c.observation.rawBody+=' ';expect(()=>prepareCurrentProfile(c,'a'.repeat(64),selection)).toThrow();
 expect(()=>prepareCurrentProfile({...capture(),mode:'current_catalogue_capture'},'a'.repeat(64),selection)).toThrow();
 expect(()=>prepareCurrentProfile(capture(),'a'.repeat(64),{...selection,reviewedAt:'2025-01-01T00:00:00.000Z'})).toThrow();
});
