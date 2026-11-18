import type {RoleProfilesReport} from '@dota/contracts';
import {rolePlayerName} from './role-editor';

type Player=Pick<RoleProfilesReport['players'][number],'playerId'|'accountIds'|'identityStatus'>;
export type MatchingLabelsReport=Pick<RoleProfilesReport,'binding'|'sources'>&{players:Player[]};
const readable=(name:string|null|undefined)=>{const value=name?.trim();return value&&/[\p{L}\p{N}\p{P}\p{S}]/u.test(value)?value:null;};

/** Display only: selected names never establish a numeric link or role eligibility. */
export function matchingPlayerName(id:string,selected:string|undefined,report?:MatchingLabelsReport):string{
 const local=readable(selected);if(local)return local;
 const player=report?.players.find(p=>p.playerId===id),verified=player&&report?readable(rolePlayerName(report,player)):null;
 return verified??(selected!==undefined?'Игрок без ника':'Имя недоступно');
}
export function matchingSourceName(source:RoleProfilesReport['sources'][number],report:MatchingLabelsReport,labels?:Record<string,string>):string{
 if(source.provider==='pandascore')return 'Заявка турнира PandaScore';
 const account=source.sourceKey.match(/^stratz:player:([1-9]\d*)$/)?.[1];
 const players=account?report.players.filter(p=>p.identityStatus==='verified'&&p.accountIds.length===1&&p.accountIds[0]===account):[];
 return players.length===1?`Профиль STRATZ: ${matchingPlayerName(players[0]!.playerId,labels?.['player:'+players[0]!.playerId],report)}`:'Профиль игрока STRATZ';
}
