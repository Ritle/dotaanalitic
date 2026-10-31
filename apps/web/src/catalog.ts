import { ownerAuth, AuthRequestError } from './auth';
import { queryClient } from './query-client';

export async function readCatalog<T>(path: string, schema: {parse(value:unknown):T}, signal: AbortSignal): Promise<T> {
  const response = await fetch('/api/v1/'+path, {credentials:'same-origin',cache:'no-store',signal});
  if (response.status===401) {
    ownerAuth.value=null; queryClient.clear();
    throw new AuthRequestError(401,'Сессия завершена. Войдите снова.');
  }
  if (!response.ok) throw new Error(response.status===404?'Запись не найдена в локальной базе.':response.status===400?
    'Некорректные фильтры. Проверьте ID, временное окно и игрока для выбранной роли.':'Не удалось загрузить данные. Повторите запрос.');
  return schema.parse(await response.json());
}
export const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat('ru-RU',{
  dateStyle:'medium',timeStyle:'short',timeZone:'UTC'
}).format(new Date(value))+' UTC' : 'неизвестно';
