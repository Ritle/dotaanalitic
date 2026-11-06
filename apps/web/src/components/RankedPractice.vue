<script setup lang="ts">
import {computed,ref,onUnmounted} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {CatalogIdSchema,type RankedProvider} from '@dota/contracts';
import {ownerAuth} from '../auth';
import {dateLabel} from '../catalog';
import {readRankedPractice,rankedPracticeMessage,rankedPracticeReason,rankedExclusionLabel} from '../ranked-practice';
import RankedContext from './RankedContext.vue';
const props=defineProps<{id:string}>();
const opened=ref(false),provider=ref<RankedProvider>('opendota'),busy=ref(false),submitError=ref(''),clock=ref(Date.now());
const contextBusy=ref(false);
const cache=useQueryClient(),key=computed(()=>['ranked-practice',props.id,provider.value]);
const query=useQuery({queryKey:key,enabled:computed(()=>opened.value&&!!ownerAuth.value&&CatalogIdSchema.safeParse(props.id).success),
 staleTime:60_000,gcTime:300_000,refetchOnWindowFocus:false,refetchOnReconnect:false,retry:false,
 queryFn:({signal})=>readRankedPractice(props.id,provider.value,false,signal)});
const report=computed(()=>query.data.value?.playerId===props.id&&query.data.value.provider===provider.value?query.data.value:undefined);
const observation=computed(()=>report.value?.observation);
const waiting=computed(()=>!!report.value?.retryAt&&Date.parse(report.value.retryAt)>clock.value);
const blocked=computed(()=>busy.value||contextBusy.value||query.isFetching.value||!ownerAuth.value||!report.value||report.value.identityStatus!=='verified'||
 ['disabled','not_configured','invalid_account','refresh_in_progress'].includes(report.value.reason??'')||waiting.value);
const lastMatch=computed(()=>observation.value?.maps.reduce<string|null>((last,m)=>!last||m.startedAt>last?m.startedAt:last,null)??null);
const explanation=computed(()=>rankedPracticeReason(report.value?.reason??null));
const summary=computed(()=>report.value?.statisticsEnabled?report.value.heroSummary:null);
const contextCoverage=computed(()=>{const maps=observation.value?.maps??[];return {patch:maps.filter(m=>m.patchCode!==null).length,role:maps.filter(m=>m.position!==null).length,rank:maps.filter(m=>m.averageRank!==null).length,party:maps.filter(m=>m.partySize!==null).length};});
const rate=(value:number|null)=>value===null?'—':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(value);
let refreshController:AbortController|undefined;
const timer=setInterval(()=>{if(opened.value)clock.value=Date.now();},1000);
onUnmounted(()=>{clearInterval(timer);refreshController?.abort();});
function toggle(event:Event){opened.value=(event.currentTarget as HTMLDetailsElement).open;clock.value=Date.now();}
async function refresh(){
 if(blocked.value)return;busy.value=true;submitError.value='';const selected=[...key.value],playerId=props.id,source=provider.value;
 refreshController=new AbortController();
 try{const value=await readRankedPractice(playerId,source,true,refreshController.signal);cache.setQueryData(selected,value);}
 catch(e){if(playerId===props.id&&source===provider.value)submitError.value=e instanceof Error?e.message:'Не удалось обновить рейтинговую историю.';}
 finally{busy.value=false;refreshController=undefined;clock.value=Date.now();}
}
function changeSource(){submitError.value='';}
</script>

<template>
 <details class="panel ranked-practice" @toggle="toggle">
  <summary><h2>Рейтинговая практика</h2><span class="hint">Последние 30 дней · All Pick</span></summary>
  <section v-if="opened" aria-label="Рейтинговая практика игрока" :aria-busy="busy||query.isFetching.value">
   <div class="ranked-controls">
    <div><label for="ranked-source">Источник рейтинговых игр</label><select id="ranked-source" v-model="provider" :disabled="busy||contextBusy" @change="changeSource"><option value="opendota">OpenDota</option><option value="stratz">STRATZ</option></select></div>
    <button type="button" :disabled="blocked" @click="refresh">{{busy?'Обновляем историю…':report?.status==='not_loaded'?'Загрузить рейтинговую историю':'Обновить рейтинговую историю'}}</button>
   </div>
   <p v-if="query.isPending.value" role="status">Проверяем сохранённую рейтинговую историю…</p>
   <div v-if="query.isError.value" role="alert"><p class="error">{{query.error.value?.message}}</p><button type="button" :disabled="query.isFetching.value" @click="query.refetch()">Повторить проверку</button></div>
   <template v-if="report">
    <p role="status" :class="{warning:report.stale||['partial','conflict','unavailable'].includes(report.status)}">{{rankedPracticeMessage(report)}}</p>
    <p v-if="explanation" class="hint">{{explanation}}</p>
    <p v-if="waiting" class="hint">Повторное обновление: {{dateLabel(report.retryAt)}}.</p>
    <button v-if="report.reason==='refresh_in_progress'" type="button" :disabled="query.isFetching.value" @click="query.refetch()">Проверить результат обновления</button>
    <template v-if="observation">
     <p class="hint">{{provider==='opendota'?'OpenDota':'STRATZ'}} · {{dateLabel(observation.fromAt)}} — {{dateLabel(observation.cutoffAt)}}.<br />Обновлено: {{dateLabel(observation.fetchedAt)}}<span v-if="report.stale"> · данные устарели</span>.</p>
     <p v-if="observation.maps.length">Доступно рейтинговых карт: <strong>{{observation.maps.length}}</strong>. Последняя найденная игра: {{dateLabel(lastMatch)}}.</p>
     <section v-if="summary&&summary.games>0" aria-label="Практика рейтинговых героев" class="ranked-heroes">
      <h3>Практика по героям</h3>
      <p class="hint">{{summary.games}} наблюдаемых игр · героев {{summary.heroes.length}}. WR — сырая частота побед в этой выборке. При малом числе игр она не подтверждает силу игрока на герое.</p>
      <div class="table-scroll" role="region" aria-label="Таблица рейтинговой практики" tabindex="0"><table class="ranked-hero-table">
       <caption class="sr-only">Наблюдаемая рейтинговая практика по героям · OpenDota</caption>
       <thead><tr><th scope="col">Герой</th><th scope="col">Игры (N)</th><th scope="col">Победы</th><th scope="col">Наблюдаемый WR</th><th scope="col">Последняя игра (UTC)</th></tr></thead>
       <tbody><tr v-for="hero in summary.heroes" :key="hero.heroId"><th scope="row">{{hero.heroName??`Герой ID ${hero.heroId}`}}</th><td>{{hero.games}}</td><td>{{hero.wins}}</td><td>{{rate(hero.winRate)}}</td><td>{{dateLabel(hero.lastPlayedAt)}}</td></tr></tbody>
      </table></div>
      <p class="hint">Все роли вместе, без скрытых весов и сглаживания. Это рейтинговые игры, а не оценка вероятности победы в профессиональном матче.</p>
     </section>
     <RankedContext v-if="report.observationId&&summary&&summary.games>0" :key="report.observationId" :player-id="id" :parent-observation-id="report.observationId" :heroes="summary.heroes" :disabled="busy" @busy="contextBusy=$event" />
     <details class="ranked-coverage"><summary>Покрытие рейтинговой истории</summary>
      <dl class="metadata"><dt>Получено строк</dt><dd>{{observation.coverage.receivedRows}}</dd><dt>Пригодных карт</dt><dd>{{observation.maps.length}}</dd>
       <dt>Выдача источника</dt><dd>{{observation.coverage.pagination==='capped'?'Достигнут лимит — показана часть истории':observation.coverage.pagination==='interrupted'?'Загрузка прервана — показана часть истории':'Доступная выдача просмотрена'}}</dd>
       <dt>Полнота всей истории</dt><dd>Неизвестна</dd><dt>Повторные записи</dt><dd>{{observation.coverage.duplicates}}</dd><dt>Противоречивые карты</dt><dd>{{observation.coverage.conflicts}}</dd>
       <dt>Подтверждённый аккаунт Steam32</dt><dd>{{report.accountId}}</dd></dl>
      <p class="hint">Контекст карт (из {{observation.maps.length}}): патч известен {{contextCoverage.patch}}, роль {{contextCoverage.role}}, средний ранг лобби {{contextCoverage.rank}}, размер группы {{contextCoverage.party}}. Остальные значения неизвестны. Ранг лобби не является личным MMR игрока.</p>
      <p class="hint">Фильтры: рейтинговое лобби, All Pick, завершение до среза. До 200 записей источника, без скрытого фильтра качества.</p>
      <ul v-if="Object.keys(observation.coverage.excluded).length"><li v-for="(count,reason) in observation.coverage.excluded" :key="reason">{{rankedExclusionLabel(reason)}}: {{count}}</li></ul>
      <p v-if="observation.coverage.stopReason" class="hint">{{rankedPracticeReason(observation.coverage.stopReason)||'Источник не завершил выдачу.'}}</p>
     </details>
    </template>
    <p v-else class="hint">Окно загрузки: последние 30 дней, рейтинговый All Pick. Сохранённых данных этого источника пока нет.</p>
    <p class="hint">История может быть неполной. Отсутствие записей не означает отсутствие опыта игрока.<span v-if="!report.statisticsEnabled"> Показатели по героям этого источника пока недоступны.</span></p>
   </template>
   <p v-if="submitError" role="alert" class="error">{{submitError}}</p>
  </section>
 </details>
</template>
<style scoped>
.ranked-practice{padding:var(--space-4);overflow-wrap:anywhere}
.ranked-practice>summary{cursor:pointer;min-height:44px;align-content:center}
h2{display:inline;font-size:18px;margin:0 var(--space-3) 0 0}.ranked-practice>summary .hint{display:inline-block}
section{padding-top:var(--space-3)}.ranked-controls{display:flex;gap:var(--space-3);align-items:end;flex-wrap:wrap}
.ranked-controls>div{flex:1;min-width:160px}.ranked-controls label{display:block;margin-bottom:var(--space-2);font-size:14px}
.ranked-controls button{max-width:100%}.ranked-coverage{border-top:1px solid var(--color-border);padding-top:var(--space-2)}
.ranked-coverage summary{cursor:pointer;min-height:44px;align-content:center}summary:focus-visible{outline:2px solid var(--color-accent);outline-offset:4px}
.ranked-heroes h3{font-size:16px;margin-top:var(--space-4)}.ranked-hero-table{min-width:580px}.ranked-hero-table th:first-child{min-width:130px}.ranked-hero-table td:first-child{min-width:0}
</style>
