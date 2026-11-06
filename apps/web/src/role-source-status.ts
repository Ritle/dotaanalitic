import type {RoleProfilesReport} from '@dota/contracts';
type Player=RoleProfilesReport['players'][number];
type Source=RoleProfilesReport['sources'][number];
type Candidate=Player['candidates'][number];

/** Display-only diagnostics. Eligibility remains the server's decision. */
export function roleSourceStatus(source:Source):string{
 if(source.reason==='disabled')return 'Профили API выключены. Можно использовать pro-историю или выбрать роли вручную.';
 if(source.reason==='not_configured')return 'Источник не настроен. Можно использовать другой источник или выбрать роли вручную.';
 if(source.reason==='refresh_in_progress')return 'Обновление уже выполняется. Дождитесь результата.';
 if(source.reason==='cooldown'||source.reason==='source_rate_limited')return 'Повторный запрос временно ограничен. Подождите перед обновлением; роли можно выбрать вручную.';
 if(source.status==='stale')return 'Данные устарели и не участвуют в автоподстановке. Нажмите «Обновить профили API».';
 if(source.status==='unavailable')return source.reason==='not_loaded'
  ?'Данные ещё не загружены. Нажмите «Обновить профили API».'
  :'Не удалось получить данные. Попробуйте обновить профили позже или выберите роли вручную.';
 if(source.observation?.players.length===0)return 'Ответ получен, но профиль не найден. Используйте другой источник или выберите роль вручную.';
 return 'Ответ получен. Применимость роли проверяется отдельно для каждого игрока.';
}

export function roleCandidateStatus(report:Pick<RoleProfilesReport,'binding'|'sources'>,player:Player,candidate:Candidate):string|null{
 if(candidate.eligible)return null;
 if(player.identityStatus!=='verified')return 'Сначала подтвердите аккаунт игрока. Совпадения ника недостаточно.';
 if(candidate.source==='pandascore'){
  const source=report.sources.find(s=>s.provider==='pandascore'&&s.sourceKey===`pandascore:roster:${report.binding.binding.pandaTournamentId}`);
  if(source&&source.status!=='ready')return roleSourceStatus(source);
 }
 if(candidate.source==='stratz'&&player.accountIds.length===1){
  const account=player.accountIds[0]!,source=report.sources.find(s=>s.provider==='stratz'&&s.sourceKey===`stratz:player:${account}`);
  if(source&&source.status!=='ready')return roleSourceStatus(source);
  const observation=source?.observation;
  if(source?.status==='ready'&&observation?.provider==='stratz'&&observation.sourceKey===source.sourceKey){
   const profiles=observation.players.filter(p=>p.accountId===account&&p.providerPlayerId===account);
   if(observation.players.length===0)return 'STRATZ не вернул профессиональный профиль этого аккаунта. Используйте PandaScore, pro-историю или выберите роль вручную.';
   if(profiles.length===1){
    const profile=profiles[0]!;
    if(profile.providerTeamId===null)return 'STRATZ не указал команду игрока. Роль профиля не применяется автоматически; используйте другой источник или ручной выбор.';
    if(report.binding.binding.stratzTeamId&&profile.providerTeamId!==report.binding.binding.stratzTeamId)
     return 'В профиле STRATZ другая команда. Проверьте трансфер и сопоставление; при необходимости выберите роль вручную.';
   }
  }
 }
 if(candidate.reason==='TEAM_BINDING_MISSING')return 'Команда источника не сопоставлена. Откройте «Сопоставление источников» и подтвердите соответствие.';
 if(candidate.reason==='PLAYER_BINDING_MISSING')return 'Игрок PandaScore не сопоставлен. Выберите его запись в «Сопоставление источников».';
 if(candidate.reason==='SOURCE_NOT_FRESH')return 'Нет свежих данных. Нажмите «Обновить профили API» или выберите роль вручную.';
 if(candidate.reason==='PROFILE_TEAM_MISMATCH')return 'Команда в профиле неизвестна или не совпадает с выбранной. Проверьте сопоставление или выберите роль вручную.';
 if(candidate.reason==='PROFILE_MISSING_OR_DUPLICATE')return 'В заявке нет однозначной записи игрока. Проверьте сопоставление; при необходимости выберите роль вручную.';
 if(candidate.reason==='PROFILE_ROLE_UNKNOWN')return 'Источник не указал роль. Используйте другой источник или ручной выбор.';
 return null;
}
