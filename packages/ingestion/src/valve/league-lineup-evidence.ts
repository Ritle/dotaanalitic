import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {Steam32Schema,PlayerSlotSchema} from '@dota/contracts';
import {resolveIdentity} from '@dota/db';
import {IdentityLedgerSnapshotSchema} from '../opendota/registry-evidence.js';
import {archiveDigest,archiveStampAt} from './archive-evidence.js';
import {auditHistoricalMapAccounts} from './team-account-evidence.js';
import type {TournamentArchiveSnapshot} from './tournament-evidence.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(id=>BigInt(id)<=9223372036854775807n);
const Raw=z.union([z.number().int().nonnegative().safe(),z.string().regex(/^(0|[1-9]\d{0,18})$/)]).transform(String);
const RawId=Raw.pipe(Id),NullableId=Raw.transform(id=>id==='0'?null:id).pipe(Id.nullable());
const Account=Raw.pipe(Steam32Schema),Seconds=z.number().int().positive().max(253402300799);
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const compare=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export function leagueRosterOriginal(leagueId:string){Id.parse(leagueId);return `https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=${leagueId}&delay_seconds=0`;}
export function leagueMapOriginal(leagueId:string,matchId:string){Id.parse(leagueId);Id.parse(matchId);
  return `https://www.dota2.com/webapi/IDOTA2DPC/GetLeagueMatchMinimal/v001?league_id=${leagueId}&match_id=${matchId}`;}
function decode(bytes:Uint8Array,encoding:string){
  if(bytes.byteLength>2*1024*1024)throw new Error('league_body_too_large');
  const decoded=encoding==='gzip'?gunzipSync(bytes,{maxOutputLength:4*1024*1024}):encoding==='identity'?Buffer.from(bytes):null;
  if(decoded===null||decoded.byteLength>4*1024*1024)throw new Error('league_encoding_or_size');
  return {decoded,data:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(decoded)) as unknown};
}
const Registered=z.object({accountId:Steam32Schema,teamId:Id,alias:z.string().max(120).nullable()});
const Node=z.object({nodeId:Id,teamId1:Id.nullable(),teamId2:Id.nullable(),matchIds:z.array(Id).max(20)});
/** Registration proves a tournament roster only. It cannot establish map attendance or native sides. */
export function verifyArchivedLeagueRosters(snapshot:TournamentArchiveSnapshot,leagueId:string,teamIds:readonly string[],matchId:string){
  const selectedTeams=z.array(Id).length(2).refine(ids=>new Set(ids).size===2).parse(teamIds).sort(compare);Id.parse(matchId);
  const capturedAt=archiveStampAt(snapshot.timestamp);Time.parse(snapshot.fetchedAt);
  if(snapshot.original!==leagueRosterOriginal(leagueId)||snapshot.originalLink!==snapshot.original||
    new Date(snapshot.mementoDatetime).toISOString()!==capturedAt||capturedAt>snapshot.fetchedAt)throw new Error('league_origin_or_time');
  if(!/^[A-Z2-7]{32}$/.test(snapshot.digest)||archiveDigest(snapshot.bytes)!==snapshot.digest)throw new Error('league_digest');
  const {decoded,data}=decode(snapshot.bytes,snapshot.encoding);
  const root=z.object({info:z.object({league_id:RawId,registration_period:z.number().int().nonnegative()}),
    registered_players:z.array(z.object({account_id:Account,team_id:RawId,name:z.string().max(120).nullish()})).max(2000),
    node_groups:z.array(z.unknown()).max(1000)}).parse(data);
  if(root.info.league_id!==leagueId||new Set(root.registered_players.map(p=>p.account_id)).size!==root.registered_players.length)
    throw new Error('league_id_or_duplicate_registration');
  const members=root.registered_players.filter(p=>selectedTeams.includes(p.team_id)).map(p=>({accountId:p.account_id,
    teamId:p.team_id,alias:p.name?.trim()||null})).sort((a,b)=>compare(a.accountId,b.accountId));
  const nodes:z.infer<typeof Node>[]=[];let groupCount=0;
  function walk(groups:unknown[],depth:number){
    if(depth>8)throw new Error('league_group_depth');
    for(const raw of groups){if(++groupCount>1000)throw new Error('league_group_count');
      const g=z.object({nodes:z.array(z.unknown()).max(10000),node_groups:z.array(z.unknown()).max(1000)}).parse(raw);
      for(const value of g.nodes){const n=z.object({node_id:RawId,team_id_1:NullableId,team_id_2:NullableId,
        matches:z.array(z.object({match_id:RawId})).max(20)}).parse(value);
        nodes.push({nodeId:n.node_id,teamId1:n.team_id_1,teamId2:n.team_id_2,matchIds:n.matches.map(m=>m.match_id).sort(compare)});
        if(nodes.length>10000)throw new Error('league_node_count');}
      walk(g.node_groups,depth+1);
    }
  }
  walk(root.node_groups,0);
  if(new Set(nodes.map(n=>n.nodeId)).size!==nodes.length)throw new Error('league_duplicate_nodes');
  const relevantNodes=nodes.filter(n=>n.matchIds.includes(matchId)||n.teamId1!==null&&n.teamId2!==null&&
    selectedTeams.includes(n.teamId1)&&selectedTeams.includes(n.teamId2)).sort((a,b)=>compare(a.nodeId,b.nodeId));
  const projection={leagueId,selectedTeams,matchId,members,nodeCount:nodes.length,relevantNodes};
  return {policyVersion:'valve-league-registration-v1',scope:'tournament_registration_not_map_lineup' as const,
    status:'verified_archived_registration' as const,sourceUrl:snapshot.original,capturedAt,knownByAt:capturedAt,fetchedAt:snapshot.fetchedAt,
    registrationPeriod:root.info.registration_period,sourceRegisteredPlayers:root.registered_players.length,groupCount,...projection,
    payloadSha256:hash(snapshot.bytes),decodedSha256:hash(decoded),cdxDigest:snapshot.digest,projectionSha256:hash(JSON.stringify(projection)),
    verifiedMapLineups:0,trainingExamples:0,deployable:false};
}
const ActualPlayers=z.array(z.object({playerSlot:PlayerSlotSchema,accountId:Steam32Schema,teamNumber:z.union([z.literal(0),z.literal(1)])})).length(10)
  .refine(rows=>new Set(rows.map(p=>p.playerSlot)).size===10&&new Set(rows.map(p=>p.accountId)).size===10&&rows.every(p=>p.teamNumber===(p.playerSlot<128?0:1)));
export function verifyValveMapParticipants(input:{bytes:Uint8Array;encoding:string;fetchedAt:string;sourceUrl:string},leagueId:string,matchId:string){
  Time.parse(input.fetchedAt);if(input.sourceUrl!==leagueMapOriginal(leagueId,matchId))throw new Error('map_source_url');
  const {decoded,data}=decode(input.bytes,input.encoding);
  const m=z.object({match_id:RawId,start_time:Seconds,tourney:z.object({league_id:RawId,radiant_team_id:RawId,dire_team_id:RawId}),
    players:z.array(z.object({account_id:Account,player_slot:PlayerSlotSchema,team_number:z.union([z.literal(0),z.literal(1)])})).length(10)}).parse(data);
  const startedAt=new Date(m.start_time*1000).toISOString(),players=m.players.map(p=>({playerSlot:p.player_slot,accountId:p.account_id,teamNumber:p.team_number})).sort((a,b)=>a.playerSlot-b.playerSlot);
  if(m.match_id!==matchId||m.tourney.league_id!==leagueId||startedAt>input.fetchedAt||m.tourney.radiant_team_id===m.tourney.dire_team_id||
    new Set(players.map(p=>p.accountId)).size!==10||new Set(players.map(p=>p.playerSlot)).size!==10||
    players.some(p=>p.teamNumber!==(p.playerSlot<128?0:1)))throw new Error('map_identity_side_or_time');
  const projection={matchId,leagueId,startedAt,radiantTeamId:m.tourney.radiant_team_id,direTeamId:m.tourney.dire_team_id,players};
  return {policyVersion:'valve-map-participants-v1',scope:'retrospective_map_participation' as const,...projection,
    sourceUrl:input.sourceUrl,fetchedAt:input.fetchedAt,knownAt:null,availability:'retrospective_fact' as const,
    payloadSha256:hash(input.bytes),decodedSha256:hash(decoded),projectionSha256:hash(JSON.stringify(projection)),verifiedMapLineups:0,trainingExamples:0,deployable:false};
}
const RegistrationProof=z.object({scope:z.literal('tournament_registration_not_map_lineup'),status:z.literal('verified_archived_registration'),
  leagueId:Id,matchId:Id,selectedTeams:z.array(Id).length(2),members:z.array(Registered).max(2000),nodeCount:z.number().int().nonnegative(),
  relevantNodes:z.array(Node).max(10000),sourceUrl:z.string(),knownByAt:Time,fetchedAt:Time,projectionSha256:Sha});
const ActualProof=z.object({scope:z.literal('retrospective_map_participation'),matchId:Id,leagueId:Id,startedAt:Time,
  radiantTeamId:Id,direTeamId:Id,players:ActualPlayers,sourceUrl:z.string(),fetchedAt:Time,knownAt:z.null(),availability:z.literal('retrospective_fact'),projectionSha256:Sha});
export function auditLeagueLineupEvidence(registration:unknown,actual:unknown,map:unknown,ledgerInput:unknown,snapshotAt:string){
  const r=RegistrationProof.parse(registration),a=ActualProof.parse(actual),ledger=IdentityLedgerSnapshotSchema.parse(ledgerInput),base=auditHistoricalMapAccounts([],map,snapshotAt);
  const rProjection={leagueId:r.leagueId,selectedTeams:r.selectedTeams,matchId:r.matchId,members:r.members,nodeCount:r.nodeCount,relevantNodes:r.relevantNodes};
  const aProjection={matchId:a.matchId,leagueId:a.leagueId,startedAt:a.startedAt,radiantTeamId:a.radiantTeamId,direTeamId:a.direTeamId,players:a.players};
  if(hash(JSON.stringify(rProjection))!==r.projectionSha256||hash(JSON.stringify(aProjection))!==a.projectionSha256||
    r.sourceUrl!==leagueRosterOriginal(r.leagueId)||a.sourceUrl!==leagueMapOriginal(a.leagueId,a.matchId)||
    r.matchId!==base.matchId||a.matchId!==base.matchId||r.leagueId!==a.leagueId||r.leagueId!==z.object({leagueId:Id}).parse(map).leagueId||a.startedAt!==base.startedAt||
    r.knownByAt>r.fetchedAt||r.fetchedAt>snapshotAt||a.fetchedAt>snapshotAt||ledger.observedAt>snapshotAt)
    throw new Error('lineup_evidence_binding');
  const selectedIds=base.players.flatMap(p=>p.accountId===null?[]:[p.accountId]).sort(compare);
  const claims=ledger.observations.map(({observationId,claim})=>({observationId,...claim}));
  if(JSON.stringify([...ledger.accountIds].sort(compare))!==JSON.stringify(selectedIds)||new Set(claims.map(c=>c.observationId)).size!==claims.length||
    claims.some(c=>!selectedIds.includes(c.externalAccountId)||c.fetchedAt>ledger.observedAt))throw new Error('lineup_ledger_scope');
  const teams=[a.radiantTeamId,a.direTeamId].sort(compare);
  if(JSON.stringify(teams)!==JSON.stringify([...r.selectedTeams].sort(compare)))throw new Error('lineup_team_selection');
  if(new Set(teams).size!==2||new Set(r.members.map(m=>m.accountId)).size!==r.members.length||
    r.members.some(m=>!teams.includes(m.teamId)))throw new Error('lineup_registration_members');
  const players=base.players.map(p=>{
    const source=a.players.find(v=>v.playerSlot===p.playerSlot),agrees=source?.accountId===p.accountId;
    const teamId=p.playerSlot<128?a.radiantTeamId:a.direTeamId;
    const registered=r.knownByAt<base.startedAt&&r.members.some(m=>m.accountId===p.accountId&&m.teamId===teamId);
    const identity=p.accountId===null?null:resolveIdentity(claims,p.accountId,base.startedAt);
    return {playerSlot:p.playerSlot,accountId:p.accountId,retrospectiveTeamId:teamId,providerAgreement:agrees,
      registeredBeforeCutoff:registered,canonicalPlayerId:agrees&&identity?.status==='verified'?identity.playerId:null};
  });
  const uniqueIds=players.flatMap(p=>p.canonicalPlayerId===null?[]:[p.canonicalPlayerId]);
  for(const p of players)if(p.canonicalPlayerId!==null&&uniqueIds.filter(id=>id===p.canonicalPlayerId).length>1)p.canonicalPlayerId=null;
  const result={policyVersion:'league-lineup-scope-audit-v1',snapshotAt,matchId:base.matchId,startedAt:base.startedAt,mapCount:1,
    registeredBeforeCutoff:players.filter(p=>p.registeredBeforeCutoff).length,providerAgreementRows:players.filter(p=>p.providerAgreement).length,
    canonicalParticipants:players.filter(p=>p.canonicalPlayerId!==null).length,ledgerRevision:ledger.registryRevision,ledgerObservedAt:ledger.observedAt,
    exactRegisteredFives:teams.filter(teamId=>{const ids=r.members.filter(m=>m.teamId===teamId).map(m=>m.accountId);
      return ids.length===5&&players.filter(p=>p.retrospectiveTeamId===teamId&&p.registeredBeforeCutoff&&p.providerAgreement).length===5;}).length,
    archiveNodesReferencingMap:r.relevantNodes.filter(n=>n.matchIds.includes(base.matchId)).length,
    archiveNodesReferencingTeamPair:r.relevantNodes.filter(n=>n.teamId1!==null&&n.teamId2!==null&&n.teamId1!==n.teamId2&&teams.includes(n.teamId1)&&teams.includes(n.teamId2)).length,
    players,strictMapLineupStatus:'unavailable' as const,strictReasons:['REGISTRATION_DOES_NOT_PROVE_MAP_ATTENDANCE','ACTUAL_NATIVE_SLOTS_KNOWN_AT_UNPROVEN'],
    actualAvailability:'retrospective_fact' as const,actualKnownAt:null,verifiedMapLineups:0,trainingExamples:0,trainingReady:false,deployable:false};
  return {...result,fingerprint:hash(JSON.stringify(result))};
}
