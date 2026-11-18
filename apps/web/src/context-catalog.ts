import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {CatalogIdSchema} from '@dota/contracts';
import {ContextCatalogSchema,type ContextKind} from '../../api/src/modules/catalog/context-catalog-contract';
import {readCatalog} from './catalog';
export const contextNameKey=(kind:ContextKind,id:string)=>['context-catalog','selected',kind,id] as const;
export const emptyContextLabel=(kind:ContextKind)=>({patches:'Все патчи',leagues:'Все турниры',heroes:'Все герои',players:'Игрок не задан',teams:'Любой соперник'})[kind];
export const unnamedContextLabel=(kind:ContextKind)=>({patches:'Патч без названия',leagues:'Турнир без названия',heroes:'Герой без названия',players:'Игрок без ника',teams:'Команда без названия'})[kind];
export function useContextLabel(kind:()=>ContextKind,id:()=>string){
 const query=useQuery({queryKey:computed(()=>contextNameKey(kind(),id())),enabled:computed(()=>CatalogIdSchema.safeParse(id()).success),
  staleTime:300000,retry:false,refetchOnWindowFocus:false,
  queryFn:({signal})=>readCatalog(`context-catalog?${new URLSearchParams({kind:kind(),id:id()})}`,ContextCatalogSchema,signal)});
 const name=computed(()=>query.data.value?.items[0]?query.data.value.items[0].name.trim()||unnamedContextLabel(kind()):
  query.isFetching.value?'Загрузка названия…':'Название недоступно');
 return {query,name};
}
