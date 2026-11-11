import type {Page} from '@playwright/test';
export const scenarioPicker=(page:Page,label:string)=>page.getByRole('region',{name:label,exact:true});
export async function pickScenario(page:Page,label:string,id:string,query=id){
 const field=scenarioPicker(page,label);
 if(await field.getByRole('button',{name:'Заменить',exact:true}).count())await field.getByRole('button',{name:'Заменить',exact:true}).click();
 await field.getByRole('searchbox').fill(query);await field.getByRole('searchbox').press('Enter');
 await field.locator(`button[data-catalog-id="${id}"]`).click();
}
export async function clearScenario(page:Page,label:string){
 const field=scenarioPicker(page,label);
 if(await field.getByRole('button',{name:'Заменить',exact:true}).count())await field.getByRole('button',{name:'Заменить',exact:true}).click();
 if(await field.getByRole('button',{name:'Сбросить',exact:true}).count())await field.getByRole('button',{name:'Сбросить',exact:true}).click();
 else await field.getByRole('searchbox').fill('');
}
