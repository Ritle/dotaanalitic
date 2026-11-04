import type {UpcomingMatch} from '@dota/contracts';
export const upcomingTeamLabel=(team:UpcomingMatch['opponents'][number])=>team.name?.trim()||`Команда PandaScore #${team.providerTeamId}`;
export function upcomingParticipants(match:UpcomingMatch){
  const teams=match.opponents.filter((t,i,all)=>all.findIndex(p=>p.providerTeamId===t.providerTeamId)===i);
  const duplicate=teams.length!==match.opponents.length,complete=teams.length===2&&!duplicate;
  const label=complete?teams.map(upcomingTeamLabel).join(' — '):duplicate?'Участники требуют уточнения':
    teams.length===1?`${upcomingTeamLabel(teams[0]!)} — Соперник не указан`:'Участники не указаны';
  const message=complete?null:duplicate?'В источнике повторяется ID команды. Участники требуют проверки.':teams.length===1?
    'В источнике указана только одна команда. Соперник не указан.':'В источнике пока не указаны обе команды.';
  return {teams,complete,label,message};
}
/** Names can be corrected without changing participants. Provider order changes invalidate positional prefills too. */
export const upcomingParticipantKey=(match:UpcomingMatch)=>JSON.stringify([match.providerMatchId,...match.opponents.map(t=>t.providerTeamId)]);
// A sole participant has no established A/B slot. Never attach it to A merely because it is first in a one-row array.
export const upcomingProviderForSlot=(match:UpcomingMatch,slot:'A'|'B')=>upcomingParticipants(match).complete?match.opponents[slot==='A'?0:1]?.providerTeamId:undefined;
