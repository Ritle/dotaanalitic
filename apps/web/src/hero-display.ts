// Display only. Hero/account identity and selection never depend on a name.
export function heroDisplayName(name:string|null|undefined,id:string|number|null){
 return id===null||id===''?'Герой не указан':name==null?'Название героя недоступно':name.trim()||'Герой без названия';
}
// Native options cannot contain an expandable key; keep IDs visible to distinguish choices.
export const heroOptionLabel=(id:string|number,name?:string|null)=>`${heroDisplayName(name,id)} · ID ${id}`;
