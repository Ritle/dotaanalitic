<script setup lang="ts">
import {computed,ref,onUnmounted} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ownerAuth} from '../auth';
import {dateLabel} from '../catalog';
import {readRankedContext,rankedContextReason} from '../ranked-context';
const props=defineProps<{playerId:string;parentObservationId:string;heroes:readonly {heroId:string;heroName:string|null}[];disabled?:boolean}>(),emit=defineEmits<{busy:[value:boolean]}>();
const opened=ref(false),busy=ref(false),error=ref(''),clock=ref(Date.now()),cache=useQueryClient(),key=computed(()=>['ranked-context',props.playerId,props.parentObservationId]);
const query=useQuery({queryKey:key,enabled:computed(()=>opened.value&&!!ownerAuth.value),staleTime:60000,gcTime:300000,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false,
 queryFn:({signal})=>readRankedContext(props.playerId,props.parentObservationId,false,signal)});
const report=computed(()=>query.data.value?.playerId===props.playerId&&query.data.value.parentObservationId===props.parentObservationId?query.data.value:undefined);
const waiting=computed(()=>!!report.value?.retryAt&&Date.parse(report.value.retryAt)>clock.value),blocked=computed(()=>props.disabled||busy.value||query.isFetching.value||!ownerAuth.value||!report.value||report.value.status==='unavailable'||report.value.reason==='refresh_in_progress'||waiting.value);
const counts=computed(()=>({conflict:report.value?.maps.filter(m=>m.status==='conflict').length??0,missing:report.value?.maps.filter(m=>m.status==='unavailable').length??0,stale:report.value?.maps.filter(m=>m.stale).length??0}));
const coverage=computed(()=>({position:report.value?.maps.filter(m=>m.position!==null).length??0,version:report.value?.maps.filter(m=>m.gameVersionCode!==null).length??0}));
const lastFetchedAt=computed(()=>report.value?.maps.reduce<string|null>((last,m)=>m.sourceFetchedAt&&(!last||m.sourceFetchedAt>last)?m.sourceFetchedAt:last,null)??null);
const heroName=(id:string)=>props.heroes.find(h=>h.heroId===id)?.heroName??`Герой ID ${id}`;
let controller:AbortController|undefined;const timer=setInterval(()=>{if(opened.value)clock.value=Date.now();},1000);
onUnmounted(()=>{clearInterval(timer);controller?.abort();emit('busy',false);});
function toggle(event:Event){opened.value=(event.currentTarget as HTMLDetailsElement).open;clock.value=Date.now();}
async function refresh(){
 if(blocked.value)return;busy.value=true;emit('busy',true);error.value='';const selected=[...key.value],player=props.playerId,parent=props.parentObservationId;controller=new AbortController();
 try{const value=await readRankedContext(player,parent,true,controller.signal);if(ownerAuth.value)cache.setQueryData(selected,value);}
 catch(e){if(props.playerId===player&&props.parentObservationId===parent)error.value=e instanceof Error?e.message:'Не удалось дополнить данные STRATZ.';}
 finally{busy.value=false;emit('busy',false);controller=undefined;clock.value=Date.now();}
}
</script>
<template>
 <details class="ranked-context" @toggle="toggle">
  <summary>Дополнительные данные STRATZ</summary>
  <section v-if="opened" aria-label="Дополнение рейтинговых карт STRATZ" :aria-busy="busy||query.isFetching.value">
   <p class="hint">Оценки позиций и коды версии игры для последних 20 известных карт. Загрузка запускается кнопкой; сохранённые данные используются повторно.</p>
   <p v-if="query.isPending.value" role="status">Проверяем сохранённое дополнение…</p>
   <p v-if="query.isError.value" role="alert" class="error">{{query.error.value?.message}}</p>
   <button v-if="query.isError.value" type="button" :disabled="query.isFetching.value" @click="query.refetch()">Повторить проверку дополнения</button>
   <template v-if="report">
    <p v-if="report.status==='not_loaded'" role="status">Дополнительные данные ещё не загружены.</p>
    <p v-else-if="report.status!=='unavailable'" role="status">Дополнено {{report.matchedMaps}} из {{report.selectedMaps}} выбранных карт. Основная выборка OpenDota: {{report.parentGames}}.</p>
    <p v-if="report.matchedMaps" class="hint">Из {{report.selectedMaps}} выбранных карт: оценка позиции известна для {{coverage.position}}, код версии — для {{coverage.version}}.</p>
    <p v-if="rankedContextReason(report.reason)" :class="{warning:report.status!=='ready'}">{{rankedContextReason(report.reason)}}</p>
    <p v-if="report.parentFromAt" class="hint">Период OpenDota: {{dateLabel(report.parentFromAt)}} — {{dateLabel(report.parentCutoffAt)}}.</p>
    <p v-if="lastFetchedAt" class="hint">Источник: STRATZ · получено {{dateLabel(lastFetchedAt)}}.<span v-if="counts.stale"> Часть данных устарела.</span></p>
    <p v-if="counts.conflict||counts.missing" class="warning">Расхождения: {{counts.conflict}}; недоступные карты: {{counts.missing}}. Спорные значения не применены.</p>
    <p v-if="waiting" class="hint">Повторное обновление: {{dateLabel(report.retryAt)}}.</p>
    <div class="context-actions"><button type="button" :disabled="blocked" @click="refresh">{{busy?'Дополняем данные…':'Дополнить данные STRATZ'}}</button>
     <button v-if="report.reason==='refresh_in_progress'" type="button" :disabled="query.isFetching.value" @click="query.refetch()">Проверить сохранённое дополнение</button></div>
    <div v-if="report.maps.some(m=>m.sourceReceiptId)" class="table-scroll" role="region" aria-label="Таблица дополнения STRATZ" tabindex="0"><table>
     <caption class="sr-only">Дополнение известных рейтинговых карт STRATZ</caption>
     <thead><tr><th scope="col">Карта / начало (UTC)</th><th scope="col">Герой</th><th scope="col">Оценка позиции</th><th scope="col">Версия STRATZ</th><th scope="col">Проверка</th></tr></thead>
     <tbody><tr v-for="m in report.maps" :key="m.matchId"><th scope="row">{{m.matchId}}<br/><span class="hint">{{dateLabel(m.startedAt)}}</span></th><td>{{heroName(m.heroId)}}</td><td>{{m.position?m.position.replace('POSITION_','')+' (оценка)':'Неизвестна'}}</td><td>{{m.gameVersionCode??'Неизвестна'}}</td><td>{{m.status==='matched'?'Совпадение':m.status==='not_loaded'?'Не загружено':rankedContextReason(m.reason)}}</td></tr></tbody>
    </table></div>
   </template>
   <p v-if="error" role="alert" class="error">{{error}}</p>
   <p class="hint">Позиция — оценка источника, версия — его собственный код. Неизвестные поля остаются неизвестными. Игры, победы и WR основной таблицы рассчитываются по прежней выборке OpenDota.</p>
  </section>
 </details>
</template>
<style scoped>
.ranked-context{border-top:1px solid var(--color-border);margin-top:var(--space-4);padding-top:var(--space-2)}summary{cursor:pointer;min-height:44px;align-content:center}summary:focus-visible{outline:2px solid var(--color-accent);outline-offset:4px}
.context-actions{display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-3)}button{max-width:100%}table{min-width:680px}th:first-child{min-width:150px}th:nth-child(2){min-width:120px}
</style>
