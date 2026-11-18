import {OwnerPermissionErrorSchema} from '../../api/src/modules/catalog/lineup-templates-contract';
import { ownerAuth, accountAccess, AuthRequestError } from './auth';
import { queryClient } from './query-client';
// Direct source import keeps the model-pinned contracts barrel and lockfile unchanged.
import { CatalogueErrorCodeSchema } from '../../../packages/contracts/browser/catalogue-error-code';
const catalogueMessages={
  CATALOGUE_CONFLICT:'Сопоставление или данные аккаунтов изменились. Ваш выбор сохранён в форме. Перечитайте связи, проверьте аккаунты и подтвердите пятёрку заново.',
  CATALOGUE_SOURCE_CHANGED:'Заявка или каталог источника обновились. Ваш выбор сохранён в форме. Обновите составы, перечитайте связи и подтвердите выбор заново.',
  CATALOGUE_SOURCE_UNAVAILABLE:'Источник пока недоступен или уже обновляется. Ваш выбор сохранён в форме. Повторите позже.',
  CATALOGUE_INVALID:'Выберите команду и пять разных аккаунтов, проверьте заявку и подтвердите соответствие.',
};
export class CatalogRequestError extends Error {
  constructor(public readonly status:number,message:string,public readonly code?:string){super(message);}
}

export async function readCatalog<T>(path: string, schema: {parse(value:unknown):T}, signal: AbortSignal, init?:RequestInit): Promise<T> {
  const response = await fetch('/api/v1/'+path, {...init,credentials:'same-origin',cache:'no-store',signal});
  if (response.status===401) {
    ownerAuth.value=null; accountAccess.value=null; queryClient.clear();
    throw new AuthRequestError(401,'Сессия завершена. Войдите снова.');
  }
  if(response.status===403){
    const denied=OwnerPermissionErrorSchema.safeParse(await response.clone().json().catch(()=>null));
    if(denied.success){accountAccess.value=null;throw new CatalogRequestError(403,'Изменять составы и роли может только владелец.','OWNER_REQUIRED');}
  }
  if(!response.ok&&/^teams\/\d+\/lineup-template$/.test(path)){
    if(response.status===409)throw new CatalogRequestError(409,'Шаблон владельца уже изменён. Ручные роли сохранены. Перечитайте шаблон и подтвердите выбор заново.','LINEUP_TEMPLATE_CONFLICT');
    if(response.status===400)throw new CatalogRequestError(400,'Выберите пять разных игроков и роли 1–5.');
  }
  if (!response.ok && /^upcoming\/\d+\/catalogue(?:\/(?:apply|prepare|search))?$/.test(path)) {
    // Only known application codes select local copy; never echo provider text/HTML.
    const parsed=CatalogueErrorCodeSchema.safeParse(await response.json().catch(()=>null));
    const code=parsed.success?parsed.data.error.code:undefined;
    if(code)throw new CatalogRequestError(response.status,catalogueMessages[code],code);
    if(response.status===409)throw new CatalogRequestError(409,catalogueMessages.CATALOGUE_CONFLICT);
  }
  if (!response.ok) throw new CatalogRequestError(response.status,response.status===422?'Выбранный герой недоступен по подтверждённому источнику. Проверьте доступность и измените выбор.':response.status===409?'Сценарий уже изменён. Ваши правки сохранены в форме; загрузите актуальную редакцию.':response.status===404?'Запись не найдена в локальной базе.':response.status===400?
    (path.startsWith('scenarios')?'Проверьте ID команд и игроков в каталоге, даты, подтверждение составов и контекст одной карты.':'Некорректные фильтры. Проверьте ID, временное окно и игрока для выбранной роли.'):response.status===403?
    'Проверка сессии устарела. Обновите страницу.':'Не удалось загрузить данные. Повторите запрос.');
  return schema.parse(await response.json());
}
export const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat('ru-RU',{
  dateStyle:'medium',timeStyle:'short',timeZone:'UTC'
}).format(new Date(value))+' UTC' : 'неизвестно';
