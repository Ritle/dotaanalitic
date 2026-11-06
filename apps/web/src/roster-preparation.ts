import type {RosterCatalogueCandidate,RosterCataloguePrepared} from '@dota/contracts';
/** A suggested draft choice still needs owner review; no tie-breaking by sample size. */
export function preferredHistoryCandidate(candidates:readonly RosterCatalogueCandidate[]):RosterCatalogueCandidate|null{
 const known=candidates.filter(p=>p.localPlayerId&&!p.discovery&&(p.proMaps??0)>0);
 return known.length===1?known[0]!:null;
}
export function preparedTeamView(team:RosterCataloguePrepared['teams'][number],choices:Record<string,RosterCatalogueCandidate|null>,selectedIds:readonly string[],reservedAccounts:readonly string[]=[]){
 const players=team.players.map(p=>({...p,selected:selectedIds.includes(p.providerPlayerId),account:choices[p.providerPlayerId]??null}));
 const selected=players.filter(p=>p.selected),accounts=selected.flatMap(p=>p.account?[p.account.id]:[]);
 const collision=new Set(accounts).size!==accounts.length||accounts.some(id=>reservedAccounts.includes(id));
 const canUse=selected.length===5&&accounts.length===5&&!collision&&selected.every(p=>!p.account?.discovery);
 const canAutoUse=canUse&&players.length===5&&selected.every(p=>p.status==='linked'&&p.account?.localPlayerId&&p.candidates.length===1&&p.account.id===p.candidates[0]!.id);
 const message=collision?'Аккаунт повторяется в выбранных составах. Уточните игроков.':players.length>5&&selected.length!==5?
  `В заявке ${players.length} игроков. Выберите пятерых.`:!players.length?'Заявка отсутствует. Обновите составы.':
  !canUse?'Уточните аккаунты игроков: есть неоднозначные или неподтверждённые соответствия.':
  canAutoUse?'Аккаунты проверены ранее. Пятёрка готова к выбору.':'Проверьте имена и числовые аккаунты, затем подтвердите пятёрку.';
 return {providerTeamId:team.providerTeamId,players,canUse,canAutoUse,message};
}
export type PreparedTeamView=ReturnType<typeof preparedTeamView>;
export type RosterPreparationNotice={slot:'A'|'B';view:PreparedTeamView|null;message:string;busy:boolean;error:string};
