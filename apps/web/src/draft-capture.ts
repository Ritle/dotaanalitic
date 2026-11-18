import type {ScenarioSnapshot} from '@dota/contracts';

export function hasCompleteDraft(scenario:ScenarioSnapshot){
  const picks=scenario.input.draft?.assignments??[];
  return picks.length===10&&new Set(picks.map(p=>p.heroId)).size===10;
}
const reasons:Record<string,string>={
  TEN_DISTINCT_HEROES_REQUIRED:'Нужны десять разных героев.',
  PLAYER_ACCOUNT_UNRESOLVED:'Не для всех игроков подтверждён единственный Steam-аккаунт.',
  TEN_DISTINCT_ACCOUNTS_REQUIRED:'Не удалось установить десять разных аккаунтов игроков.',
  DRAFT_TARGET_MISMATCH:'Назначение встречи не соответствует командам или номеру карты.',
  DRAFT_MAP_REFERENCE_MISSING:'Нет проверенной ссылки на встречу и номер карты.',
  DRAFT_CAPTURE_HISTORY_LIMIT:'Объём истории превышает лимит снимка. История не была усечена.',
  LOCAL_HISTORY_UNAVAILABLE:'Локальная история недоступна для этого снимка.',
  PLAYER_PRO_HISTORY_MISSING:'Для части игроков нет профессиональных карт в локальной истории.',
};
export const captureReason=(code:string)=>reasons[code]??'Часть данных не прошла проверку. Снимок сохранён с ограничениями.';
