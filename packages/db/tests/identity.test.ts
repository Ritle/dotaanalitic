import { describe, expect, it } from 'vitest';
import { AccountEvidenceSchema, type StoredAccountEvidence, type ContextObservation } from '@dota/contracts';
import { resolveIdentity, resolveLineup } from '../src/identity.js';
import { resolveContextAsOf } from '../src/temporal.js';

const cutoffAt='2024-01-01T12:00:00.000Z';
const proof:StoredAccountEvidence={observationId:'proof:1',playerId:'9007199254740993',provider:'opendota',externalAccountId:'123',
  status:'verified',eventAt:null,knownAt:cutoffAt,fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:proof',source:'synthetic'};
const slots=Array.from({length:10},(_,i)=>({playerSlot:i<5?i:i+123,playerId:String(i+1)}));
const roleRows=slots.map((slot,i)=>({...slot,rolePos:i%5+1,basis:'confirmed' as const,confidence:1}));
function context(facts:ContextObservation['fact'][],overrides:Partial<ContextObservation>={}){
  return resolveContextAsOf(facts.map((fact,i)=>({id:String(i+1),matchId:'10',fact,eventAt:null,knownAt:cutoffAt,
    fetchedAt:'2026-10-31T00:00:00.000Z',availability:'verified_asof' as const,earliestStage:'pre_match' as const,
    provider:'synthetic',providerRecordId:null,evidenceRef:'synthetic:lineup',adapterVersion:'test',reviewState:'accepted' as const,...overrides})),
    {matchId:'10',cutoffAt,stage:'pre_match'});
}

describe('canonical identity proof',()=>{
  it('resolves only verified accounts and keeps bigint ID exact',()=>{
    expect(resolveIdentity([proof],'123',cutoffAt).playerId).toBe(proof.playerId);
    expect(resolveIdentity([{...proof,status:'provisional'}],'123',cutoffAt).status).toBe('unknown');
    expect(resolveIdentity([{...proof,status:'rejected'}],'123',cutoffAt).status).toBe('unknown');
    expect(resolveIdentity([proof],'124',cutoffAt).playerId).toBeNull();
  });
  it('rejects nickname matching, zero accounts, unsafe IDs and unsupported account namespaces',()=>{
    for(const change of [{externalAccountId:'0'},{externalAccountId:'4294967296'},{playerId:9007199254740993},
      {nickname:'same'},{provider:'nickname'},{evidenceRef:null},{knownAt:'2027-01-01T00:00:00.000Z'}]){
      const {observationId,...row}=proof;
      expect(AccountEvidenceSchema.safeParse({...row,...change}).success).toBe(false);
    }
  });
  it('uses dated proof but never fetch time or current legacy links for as-of identity',()=>{
    expect(resolveIdentity([{...proof,knownAt:null}],'123',cutoffAt).playerId).toBeNull();
    expect(resolveIdentity([{...proof,knownAt:null}],'123',null).playerId).toBe(proof.playerId);
    expect(resolveIdentity([{...proof,knownAt:'2024-01-01T12:00:00.001Z'}],'123',cutoffAt).playerId).toBeNull();
    expect(resolveIdentity([{...proof,eventAt:'2024-01-01T12:00:00.001Z'}],'123',cutoffAt).playerId).toBeNull();
  });
  it('same verified Steam32 on two people conflicts across providers; ordering cannot choose winner',()=>{
    const rows=[proof,{...proof,provider:'stratz' as const,playerId:'9007199254740995',observationId:'proof:2'}];
    expect(resolveIdentity(rows,'123',cutoffAt)).toEqual(resolveIdentity([...rows].reverse(),'123',cutoffAt));
    expect(resolveIdentity(rows,'123',cutoffAt)).toMatchObject({status:'conflict',playerId:null});
  });
  it('corroboration and provisional alternative do not merge people or erase verified proof',()=>{
    const rows=[proof,{...proof,provider:'stratz' as const,observationId:'proof:2'},
      {...proof,playerId:'99',status:'provisional' as const,observationId:'proof:3'}];
    expect(resolveIdentity(rows,'123',cutoffAt)).toMatchObject({playerId:proof.playerId,observationIds:['proof:1','proof:2']});
  });
  it('late contradictory evidence leaves an earlier identity unchanged',()=>{
    const future={...proof,playerId:'9',knownAt:'2025-01-01T00:00:00.000Z',observationId:'proof:2'};
    expect(resolveIdentity([proof,future],'123',cutoffAt)).toEqual(resolveIdentity([proof],'123',cutoffAt));
    expect(resolveIdentity([proof,future],'123',null).status).toBe('conflict');
  });
  it('an evidenced rejection cannot silently leave a verified link active',()=>{
    expect(resolveIdentity([proof,{...proof,status:'rejected',observationId:'proof:2'}],'123',cutoffAt))
      .toMatchObject({playerId:null,status:'conflict'});
  });
});

describe('lineup and role evidence',()=>{
  const ids=slots.map(slot=>slot.playerId);
  it('builds five per native side independent of input order, roles and organization',()=>{
    const facts:ContextObservation['fact'][]=[{field:'lineup',value:[...slots].reverse()},{field:'roles',value:[...roleRows].reverse()}];
    const result=resolveLineup(context(facts),ids);
    expect(result.sides.map(side=>side.fingerprint)).toEqual(['1:2:3:4:5','6:7:8:9:10']);
    expect(result.sides.every(side=>side.complete && side.rolesConfirmed)).toBe(true);
    const swapped=roleRows.map(role=>({...role,rolePos:6-role.rolePos}));
    expect(resolveLineup(context([{field:'lineup',value:slots},{field:'roles',value:swapped}]),ids).sides[0]?.fingerprint)
      .toBe(result.sides[0]?.fingerprint);
  });
  it('estimated roles never become confirmed, including high confidence; low-confidence confirmed is unknown',()=>{
    for(const [basis,confidence] of [['estimated',1],['estimated',0.2],['confirmed',0.2]] as const){
      const value=roleRows.map(role=>({...role,basis,confidence}));
      const result=resolveLineup(context([{field:'lineup',value:slots},{field:'roles',value}]),ids);
      expect(result.sides.every(side=>side.complete && !side.rolesConfirmed)).toBe(true);
      expect(result.sides[0]!.players[0]).toMatchObject({rolePos:null,roleEvidence:{rolePos:1,basis,confidence}});
    }
  });
  it('missing role does not become position derived from slot',()=>{
    const result=resolveLineup(context([{field:'lineup',value:slots}]),ids);
    expect(result.sides.every(side=>side.players.every(player=>player.rolePos===null))).toBe(true);
  });
  it('duplicate roles and role-to-player mismatch fail closed while preserving original evidence',()=>{
    const duplicate=roleRows.map(role=>({...role,rolePos:1}));
    const result=resolveLineup(context([{field:'lineup',value:slots},{field:'roles',value:duplicate}]),ids);
    expect(result.warnings).toContain('ROLE_CONFLICT');
    expect(result.sides[0]!.players.every(player=>player.rolePos===null)).toBe(true);
    const mismatch=roleRows.map(role=>({...role,playerId:String(BigInt(role.playerId)+100n)}));
    expect(resolveLineup(context([{field:'lineup',value:slots},{field:'roles',value:mismatch}]),ids).warnings).toContain('ROLE_IDENTITY_MISMATCH');
  });
  it('partial, anonymous and nonexistent identities leave fingerprint unknown',()=>{
    for(const value of [slots.slice(0,4),slots.map(row=>({...row,playerId:null})),slots]){
      const result=resolveLineup(context([{field:'lineup',value}]),ids.slice(0,4));
      expect(result.sides.every(side=>!side.complete && side.fingerprint===null)).toBe(true);
    }
  });
  it('retrospective/user-asserted/current member information cannot create a historical known lineup',()=>{
    for(const availability of ['retrospective_fact','user_asserted_asof','unknown'] as const){
      const result=resolveLineup(context([{field:'lineup',value:slots}],{availability}),ids);
      expect(result.sides.every(side=>!side.complete)).toBe(true);
    }
  });
  it('duplicate player across opposite sides is rejected by the context boundary',()=>{
    expect(()=>context([{field:'lineup',value:slots.map((row,i)=>i===9?{...row,playerId:'1'}:row)}])).toThrow();
  });
});
