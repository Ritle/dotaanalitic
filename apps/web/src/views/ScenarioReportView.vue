<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ScenarioSnapshotSchema,ScenarioReportQuerySchema,ScenarioReportCreateSchema,ScenarioReportSchema,ScenarioReportHistorySchema} from '@dota/contracts';
import {readCatalog,dateLabel,CatalogRequestError} from '../catalog';
import {ownerAuth} from '../auth';
import ScenarioReportContent from '../components/ScenarioReportContent.vue';
const route=useRoute(),router=useRouter(),cache=useQueryClient(),id=computed(()=>String(route.params.id??''));
const filters=reactive({from:'',patchScope:'all',patchId:'',leagueId:'',reuseWeights:false}),offset=ref(0),busy=ref(false),error=ref('');
const scenario=useQuery({queryKey:computed(()=>['scenario',id.value]),queryFn:({signal})=>readCatalog(`scenarios/${id.value}`,ScenarioSnapshotSchema,signal)});
const history=useQuery({queryKey:computed(()=>['scenario-reports',id.value,offset.value]),queryFn:({signal})=>readCatalog(`scenarios/${id.value}/analyses?offset=${offset.value}`,ScenarioReportHistorySchema,signal)});
const selectedId=computed(()=>typeof route.query.analysis==='string'?route.query.analysis:history.data.value?.items[0]?.id??'');
const saved=useQuery({queryKey:computed(()=>['analysis',selectedId.value]),enabled:computed(()=>!!selectedId.value),staleTime:Infinity,retry:false,
  queryFn:({signal})=>readCatalog(`analyses/${selectedId.value}`,ScenarioReportSchema,signal)});
const selected=computed(()=>saved.data.value?.report.scenario.id===id.value?saved.data.value:null);
watch(id,()=>{offset.value=0;error.value='';filters.reuseWeights=false;});
async function create(){
  if(!scenario.data.value||busy.value)return;const scope=id.value;
  const from=filters.from?new Date(filters.from+'Z'):null;
  if(from&&!Number.isFinite(from.getTime())){error.value='Проверьте начало периода UTC.';return;}
  const q=ScenarioReportQuerySchema.safeParse({expectedRevision:scenario.data.value.revision,fromAt:from?.toISOString(),patchScope:filters.patchScope,
    patchId:filters.patchScope==='specific'?filters.patchId:undefined,leagueId:filters.leagueId||undefined,
    weights:filters.reuseWeights?selected.value?.report.query.weights:undefined});
  if(!q.success){error.value='Проверьте период, патч и ID лиги.';return;}
  error.value='';busy.value=true;
  try{const result=await readCatalog(`scenarios/${scope}/analyses`,ScenarioReportCreateSchema,new AbortController().signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(q.data)});
    if(id.value!==scope)return;if('status' in result){error.value=result.message;return;}
    cache.setQueryData(['analysis',result.id],result);offset.value=0;await cache.invalidateQueries({queryKey:['scenario-reports',scope]});await router.replace({query:{analysis:result.id}});
  }catch(e){if(id.value===scope)error.value=e instanceof CatalogRequestError&&e.status===400?'Проверьте период, патч и ID исторической лиги.':e instanceof CatalogRequestError&&e.status===409?'Редакция сценария изменилась. Обновите текущую редакцию и повторите расчёт.':e instanceof Error?e.message:'Не удалось сохранить отчёт.';}
  finally{busy.value=false;}
}
async function refresh(){await scenario.refetch();}
</script>
<template>
  <main class="page"><h1>Отчёты сценария</h1><RouterLink :to="`/scenarios/${id}`">Вернуться к сценарию</RouterLink>
    <p v-if="scenario.isPending.value||history.isPending.value" role="status">Загрузка сценария и истории…</p>
    <p v-if="scenario.error.value||history.error.value" role="alert" class="error">{{scenario.error.value?.message??history.error.value?.message}}</p>
    <section v-if="scenario.data.value" class="panel" aria-label="Создать версию отчёта"><h2>Новый отчёт</h2><p>{{scenario.data.value.input.title}} · текущая редакция {{scenario.data.value.revision}}. Каждый успешный расчёт сохраняется отдельной неизменяемой версией.</p>
      <form @submit.prevent="create"><div class="report-filters"><label>Отчёт: начало периода UTC<input v-model="filters.from" type="datetime-local" /><small>По умолчанию 90 дней до среза сценария.</small></label>
        <label>Отчёт: патч<select v-model="filters.patchScope"><option value="all">Все патчи</option><option value="current">На дату среза</option><option value="specific">Конкретный патч</option></select></label>
        <label v-if="filters.patchScope==='specific'">Отчёт: ID патча<input v-model="filters.patchId" inputmode="numeric" /></label><label>Отчёт: ID исторической лиги<input v-model="filters.leagueId" inputmode="numeric" placeholder="Все лиги" /></label></div>
        <label v-if="selected?.report.query.weights" class="reuse-policy"><input v-model="filters.reuseWeights" type="checkbox" /> Использовать экспериментальную политику весов выбранной версии</label>
        <p class="hint">Веса по умолчанию выключены. Сглаженные оценки имеют отдельную опорную выборку. Прогноз недоступен.</p>
        <button :disabled="busy" type="submit">{{busy?'Сохранение отчёта…':'Рассчитать и сохранить отчёт'}}</button></form>
      <p v-if="error" role="alert" class="error">{{error}}</p><button :disabled="busy" @click="refresh">Обновить текущую редакцию сценария</button>
    </section>
    <section class="panel" aria-label="История отчётов"><h2>История отчётов</h2><p v-if="history.data.value&&!history.data.value.items.length">Сохранённых отчётов пока нет.</p>
      <ul><li v-for="r in history.data.value?.items" :key="r.id"><RouterLink :to="{query:{analysis:r.id}}" :aria-current="selectedId===r.id?'page':undefined">Версия {{r.version}} · редакция {{r.scenarioRevision}}</RouterLink><span>{{dateLabel(r.createdAt)}}</span></li></ul>
      <div class="pagination"><button v-if="offset" @click="offset-=20">Новые отчёты</button><button v-if="history.data.value?.hasMore" @click="offset+=20">Ранние отчёты</button></div>
    </section>
    <p v-if="selectedId&&saved.isFetching.value" role="status">Загрузка сохранённого отчёта…</p><p v-if="selectedId&&saved.error.value" role="alert" class="error">{{saved.error.value.message}}</p>
    <p v-if="saved.data.value&&!selected" class="error" role="alert">Эта версия принадлежит другому сценарию. Выберите отчёт из истории.</p>
    <p v-if="selected&&scenario.data.value&&selected.report.scenario.revision!==scenario.data.value.revision" class="warning">Отчёт относится к редакции {{selected.report.scenario.revision}}. Текущая редакция сценария {{scenario.data.value.revision}}. Сохранённые данные не пересчитываются.</p>
    <ScenarioReportContent v-if="selected" :key="selected.id" :snapshot="selected" />
  </main>
</template>
<style scoped>.report-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:16px;margin-block:16px}.report-filters label{display:grid;gap:6px;min-width:0}.report-filters input,.report-filters select{min-width:0;width:100%;box-sizing:border-box}.reuse-policy{display:flex;align-items:center;gap:10px}.reuse-policy input{width:auto}li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;padding-block:10px}ul{padding-left:20px}.page{min-width:0}section{margin-block:24px}</style>
