import {PandaScoreClient,PandaScoreError} from './client.js';
import type {PandaObservation} from './client.js';
import type {PandaUpcoming,PandaRosters} from './schemas.js';
import type {z} from 'zod';
import type {PandaPlayerIdentifierInventorySchema} from './schemas.js';

/** Capture one bounded schedule page and one tournament's expected rosters. No model/map/identity import. */
export async function auditUpcomingTournament(client:PandaScoreClient,options:{now?:()=>number;tournamentId?:string}={}){
  const now=options.now??Date.now,startedAt=new Date(now()).toISOString(),errors:{code:string;endpoint:string|null;status:number|null;retryAfterMs:number|null}[]=[];
  let schedule:PandaObservation<PandaUpcoming>|null=null,rosters:PandaObservation<PandaRosters>|null=null;
  let selected:PandaUpcoming[number]|null=null;
  let identityProbe:PandaObservation<z.output<typeof PandaPlayerIdentifierInventorySchema>>|null=null;
  try{
    schedule=await client.getUpcomingMatches();
    const cutoff=new Date(now()).toISOString();
    selected=[...schedule.data].filter(m=>m.status==='not_started'&&m.scheduledAt!==null&&m.scheduledAt>cutoff&&
      (options.tournamentId===undefined||m.tournament.providerTournamentId===options.tournamentId))
      .sort((a,b)=>a.scheduledAt!.localeCompare(b.scheduledAt!)||(BigInt(a.providerMatchId)<BigInt(b.providerMatchId)?-1:1))[0]??null;
    if(selected){
      rosters=await client.getTournamentRosters(selected.tournament.providerTournamentId);
      const opponentIds=selected.opponents.map(t=>t.providerTeamId);
      const playerId=rosters.data.filter(t=>opponentIds.includes(t.providerTeamId)).flatMap(t=>t.players)
        .map(p=>p.providerPlayerId).sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0)[0];
      if(playerId!==undefined)identityProbe=await client.getPlayerIdentifierInventory(playerId);
    }
  }catch(e){errors.push(e instanceof PandaScoreError?{code:e.code,endpoint:e.endpoint,status:e.status,retryAfterMs:e.retryAfterMs}:
    {code:'audit_failed',endpoint:null,status:null,retryAfterMs:null});}
  const generatedAt=new Date(now()).toISOString();
  const teams=selected?.opponents.map(t=>{
    const row=rosters?.data.find(r=>r.providerTeamId===t.providerTeamId);
    return {...t,rosterStatus:row===undefined?'missing':row.players.length===5?'five_expected_players':'requires_manual_selection',
      expectedPlayerCount:row?.players.length??null,players:row?.players??null,matchAttendanceConfirmed:false};
  })??[];
  const exactFives=teams.filter(t=>t.rosterStatus==='five_expected_players').length;
  return {schemaVersion:1,mode:'live_pandascore_upcoming_tournament_audit',startedAt,generatedAt,
    captureStatus:errors.length?'blocked_or_partial':selected===null?'no_future_match_in_page':rosters===null?'partial':'complete',
    selectionPolicy:'earliest_future_not_started_match_in_first_twenty_rows_then_exact_tournament_rosters',
    requestedTournamentId:options.tournamentId??null,schedule,selectedMatch:selected,rosters,identityProbe,teams,
    coverage:{scheduleRows:schedule?.data.length??null,selectedOpponentTeams:selected?.opponents.length??null,
      tournamentRosterTeams:rosters?.data.length??null,exactExpectedFives:rosters?exactFives:null,
      expectedLineupReady:rosters!==null&&teams.length===2&&exactFives===2,
      globalScheduleCoverage:'not_assessed',rosterScope:'expected_tournament_roster_not_confirmed_map_lineup',
      playerIdentityProfilesSampled:identityProbe===null?0:1,
      playerHistoryLinks:'requires_verified_provider_mapping',steamAccountCoverage:'not_assessed',canonicalPlayersLinked:0},
    requests:client.requestStats,errors,databaseWrites:0,mapResultsImported:0,trainingExamples:0,
    trainingReady:false,deployable:false};
}
