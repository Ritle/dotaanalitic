import {it,expect} from 'vitest';
import {gzipSync} from 'node:zlib';
import {archiveDigest} from '../src/valve/archive-evidence.js';
import {ArchiveEvidenceClient} from '../src/valve/archive-client.js';
import {verifyArchivedLeagueRosters,verifyValveMapParticipants,auditLeagueLineupEvidence,leagueRosterOriginal,leagueMapOriginal} from '../src/valve/league-lineup-evidence.js';
const league='15728',match='999999999999999',teams=['42','43'],horizon='2026-11-01T00:00:00.000Z',fetchAt='2026-10-31T00:00:00.000Z';
const slots=Array.from({length:10},(_,i)=>i<5?i:i+123);
const registrations=()=>slots.map((_,i)=>({account_id:101+i,team_id:i<5?42:43,name:'Synthetic alias',private:'omitted'}));
const node=()=>({node_id:1,team_id_1:0,team_id_2:0,matches:[] as {match_id:string}[]});
const leagueBody=()=>({info:{league_id:15728,registration_period:8},registered_players:registrations(),node_groups:[{nodes:[node()],node_groups:[]}]});
function snapshot(body:unknown=leagueBody(),compressed=true){const raw=Buffer.from(JSON.stringify(body)),bytes=compressed?gzipSync(raw):raw;
  return {bytes,digest:archiveDigest(bytes),encoding:compressed?'gzip':'identity',timestamp:'20231007101414',original:leagueRosterOriginal(league),
    originalLink:leagueRosterOriginal(league),mementoDatetime:'Sat, 07 Oct 2023 10:14:14 GMT',fetchedAt:fetchAt};}
const mapBody=()=>({match_id:match,start_time:1697130044,tourney:{league_id:15728,radiant_team_id:42,dire_team_id:43},
  players:slots.map((player_slot,i)=>({account_id:101+i,player_slot,team_number:i<5?0:1,kills:20,pro_name:'private',hero_id:i+1})),duration:1405,match_outcome:2});
function actual(body:unknown=mapBody()){return verifyValveMapParticipants({bytes:Buffer.from(JSON.stringify(body)),encoding:'identity',fetchedAt:fetchAt,
  sourceUrl:leagueMapOriginal(league,match)},league,match);}
const map=()=>({schemaVersion:1,mode:'live_opendota_map_account_observation',matchId:match,leagueId:league,startedAt:'2023-10-12T17:00:44.000Z',
  fetchedAt:fetchAt,knownAt:null,players:slots.map((playerSlot,i)=>({playerSlot,accountId:String(101+i)})),
  source:{endpoint:'/matches/'+match,payloadSha256:'a'.repeat(64),adapterVersion:'synthetic'}});
const ledger=()=>({schemaVersion:1,mode:'read_only_identity_ledger_snapshot',observedAt:fetchAt,registryRevision:'20',
  accountIds:slots.map((_,i)=>String(101+i)),referencesRedactedToSha256:true,
  observations:slots.map((_,i)=>({observationId:String(i+1),claim:{playerId:String(900+i),provider:'opendota',externalAccountId:String(101+i),status:'verified',
    knownAt:'2023-04-01T00:00:00.000Z',eventAt:null,fetchedAt:fetchAt,source:'synthetic',evidenceRef:'synthetic:account'}}))});
const registration=()=>verifyArchivedLeagueRosters(snapshot(),league,teams,match);
it('projects only requested tournament registrations and nullable unassigned schedule nodes',()=>{
  const b=leagueBody();b.registered_players.push({account_id:200,team_id:44,name:'Other synthetic',private:'omitted'});
  const r=verifyArchivedLeagueRosters(snapshot(b),league,teams,match);
  expect(r).toMatchObject({sourceRegisteredPlayers:11,members:expect.any(Array),nodeCount:1,relevantNodes:[],verifiedMapLineups:0});
  expect(r.members).toHaveLength(10);expect(JSON.stringify(r)).not.toMatch(/private|omitted|Other synthetic/);
});
it('validates archive original, digest, Memento, clock and league ID',()=>{
  for(const patch of [{originalLink:'https://example.invalid'},{digest:'A'.repeat(32)},{mementoDatetime:'Sun, 08 Oct 2023 10:14:14 GMT'},
    {fetchedAt:'2022-01-01T00:00:00.000Z'}])expect(()=>verifyArchivedLeagueRosters({...snapshot(),...patch},league,teams,match)).toThrow();
  expect(()=>verifyArchivedLeagueRosters(snapshot(),league,['42','42'],match)).toThrow();
  const b=leagueBody();b.info.league_id=1;expect(()=>verifyArchivedLeagueRosters(snapshot(b),league,teams,match)).toThrow();
});
it('rejects duplicate registrations and duplicated schedule node IDs',()=>{
  const b=leagueBody();b.registered_players.push(b.registered_players[0]!);expect(()=>verifyArchivedLeagueRosters(snapshot(b),league,teams,match)).toThrow();
  const c=leagueBody();c.node_groups[0]!.nodes.push(node());expect(()=>verifyArchivedLeagueRosters(snapshot(c),league,teams,match)).toThrow();
});
it('bounds nested schedule traversal and decoding, preserving unknown aliases',()=>{
  let deep:unknown={nodes:[],node_groups:[]};for(let i=0;i<10;i++)deep={nodes:[],node_groups:[deep]};
  expect(()=>verifyArchivedLeagueRosters(snapshot({...leagueBody(),node_groups:[deep]}),league,teams,match)).toThrow();
  const bytes=gzipSync(Buffer.alloc(5*1024*1024));expect(()=>verifyArchivedLeagueRosters({...snapshot(),bytes,digest:archiveDigest(bytes)},league,teams,match)).toThrow();
  expect(()=>verifyArchivedLeagueRosters({...snapshot(),encoding:'br'},league,teams,match)).toThrow();
  const b=leagueBody();b.registered_players[0]!.name='';expect(verifyArchivedLeagueRosters(snapshot(b),league,teams,match).members[0]!.alias).toBeNull();
});
it('matches relevant schedule nodes without treating team1/team2 as native sides or a series as one map',()=>{
  const b=leagueBody();b.node_groups[0]!.nodes=[{...node(),team_id_1:43,team_id_2:42,matches:[{match_id:match},{match_id:'123'}]}];
  const r=verifyArchivedLeagueRosters(snapshot(b),league,teams,match);expect(r.relevantNodes).toHaveLength(1);
  expect(r.relevantNodes[0]).toMatchObject({teamId1:'43',teamId2:'42',matchIds:['123',match]});
  expect(auditLeagueLineupEvidence(r,actual(),map(),ledger(),horizon).strictMapLineupStatus).toBe('unavailable');
});
it('validates actual native slots and strips outcomes, heroes, roles and all telemetry',()=>{
  expect(actual()).toMatchObject({availability:'retrospective_fact',knownAt:null,matchId:match,verifiedMapLineups:0});
  expect(JSON.stringify(actual())).not.toMatch(/kills|hero_id|match_outcome|duration|private|pro_name/);
  const b=mapBody();b.players.reverse();expect(actual(b).projectionSha256).toBe(actual().projectionSha256);
});
it('rejects actual duplicate accounts, invalid side/slot, wrong match/league/start and source URL',()=>{
  for(const change of [{account_id:102},{player_slot:5},{team_number:1}]){
    const b=mapBody();Object.assign(b.players[0]!,change);expect(()=>actual(b)).toThrow();}
  for(const b of [{...mapBody(),match_id:'1'},{...mapBody(),start_time:253402300799},
    {...mapBody(),tourney:{league_id:1,radiant_team_id:42,dire_team_id:43}}])expect(()=>actual(b)).toThrow();
  expect(()=>verifyValveMapParticipants({bytes:Buffer.from('{}'),encoding:'identity',fetchedAt:fetchAt,sourceUrl:'https://example.invalid'},league,match)).toThrow();
});
it('two complete historical registrations plus agreeing participants never become pre-known actual lineups',()=>{
  const r=auditLeagueLineupEvidence(registration(),actual(),map(),ledger(),horizon);
  expect(r).toMatchObject({mapCount:1,registeredBeforeCutoff:10,providerAgreementRows:10,canonicalParticipants:10,exactRegisteredFives:2,
    archiveNodesReferencingMap:0,strictMapLineupStatus:'unavailable',actualKnownAt:null,verifiedMapLineups:0,trainingExamples:0});
});
it('preserves a cross-provider participant conflict instead of overwriting it',()=>{
  const b=mapBody();b.players[0]!.account_id=1000;const r=auditLeagueLineupEvidence(registration(),actual(b),map(),ledger(),horizon);
  expect(r.providerAgreementRows).toBe(9);expect(r.canonicalParticipants).toBe(9);expect(r.exactRegisteredFives).toBe(1);
});
it('rejects tampered/future projections and ledger scope; equality at registration cutoff is not earlier evidence',()=>{
  expect(()=>auditLeagueLineupEvidence({...registration(),projectionSha256:'0'.repeat(64)},actual(),map(),ledger(),horizon)).toThrow();
  expect(()=>auditLeagueLineupEvidence({...registration(),fetchedAt:'2027-01-01T00:00:00.000Z'},actual(),map(),ledger(),horizon)).toThrow();
  expect(()=>auditLeagueLineupEvidence(registration(),actual(),map(),{...ledger(),accountIds:['101']},horizon)).toThrow();
  expect(auditLeagueLineupEvidence({...registration(),knownByAt:map().startedAt},actual(),map(),ledger(),horizon).registeredBeforeCutoff).toBe(0);
});
it('unknown/late/rejected identities and duplicate canonical people stay unavailable',()=>{
  const l=ledger();l.observations[0]!.claim.status='rejected';l.observations[1]!.claim.knownAt='2024-01-01T00:00:00.000Z';
  l.observations[2]!.claim.playerId=l.observations[3]!.claim.playerId;
  expect(auditLeagueLineupEvidence(registration(),actual(),map(),l,horizon).canonicalParticipants).toBe(6);
});
it('source arrays and map/ledger input order preserve the audit fingerprint',()=>{
  const b=leagueBody();b.registered_players.reverse();
  const l=ledger();l.observations.reverse();l.accountIds.reverse();
  expect(auditLeagueLineupEvidence(verifyArchivedLeagueRosters(snapshot(b,false),league,[...teams].reverse(),match),actual(),
    {...map(),players:[...map().players].reverse()},l,horizon)).toEqual(auditLeagueLineupEvidence(registration(),actual(),map(),ledger(),horizon));
});
it('client fixes league/index window and validates numeric IDs before current-map requests',async()=>{
  const urls:string[]=[];const c=new ArchiveEvidenceClient({now:()=>0,sleep:async()=>{},raw:async u=>{urls.push(u.href);return {status:200,headers:{},bytes:Buffer.from('[]')};}});
  await c.findTi12LeagueBefore(map().startedAt);expect(new URL(urls[0]!).searchParams.get('url')).toBe(leagueRosterOriginal(league));
  expect(new URL(urls[0]!).searchParams.get('from')).toBe('20231001000000');
  await c.getCurrentLeagueMap(league,match);expect(urls[1]).toBe(leagueMapOriginal(league,match));
  await expect(c.getCurrentLeagueMap(league,'invalid')).rejects.toThrow();expect(urls).toHaveLength(2);
});
