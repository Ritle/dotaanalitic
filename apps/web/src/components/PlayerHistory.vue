<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {SelectedPlayerHistoryRequestSchema,PlayerHistoryResponseSchema,PlayerHistoryOptionsSchema,type PlayerHistoryOptions} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{playerIds:string[];slot:'A'|'B'}>(),cache=useQueryClient(),busy=ref(false),submitError=ref('');
const ids=computed(()=>[...props.playerIds].sort()),valid=computed(()=>SelectedPlayerHistoryRequestSchema.safeParse({playerIds:ids.value}).success);
const filters=reactive<PlayerHistoryOptions>({windowDays:365,maxMaps:25}),options=computed(()=>PlayerHistoryOptionsSchema.parse(filters));
const key=computed(()=>['player-history',ids.value.join(','),options.value.windowDays,options.value.maxMaps]),path=computed(()=>`players/history-refresh?playerIds=${ids.value.join(',')}&windowDays=${options.value.windowDays}&maxMaps=${options.value.maxMaps}`);
const query=useQuery({queryKey:key,enabled:computed(()=>valid.value&&!!ownerAuth.value),queryFn:({signal})=>readCatalog(path.value,PlayerHistoryResponseSchema,signal),
 refetchInterval:q=>q.state.data?.run&&['queued','running'].includes(q.state.data.run.status)?3000:q.state.data?.retryAt?10000:false});
const data=computed(()=>valid.value?query.data.value:undefined),active=computed(()=>!!data.value?.run&&['queued','running'].includes(data.value.run.status));
const blocked=computed(()=>busy.value||!data.value?.available||active.value||!!data.value?.retryAt),last=ref('');
watch(()=>data.value?.run,async run=>{if(!run?.finishedAt||last.value===run.id+run.finishedAt)return;last.value=run.id+run.finishedAt;
 for(const prefix of ['role-profiles','role-suggestions','catalog','pro-maps','roster','player-heroes','strength','compare','upcoming-lineup-compare'])await cache.invalidateQueries({queryKey:[prefix]});
});
watch(()=>key.value.join(':'),()=>{submitError.value='';last.value='';});
async function start(resume=false){if(blocked.value||resume&&!data.value?.canResume)return;busy.value=true;submitError.value='';const selected=[...ids.value],chosen={...options.value},target=['player-history',selected.join(','),chosen.windowDays,chosen.maxMaps];
 try{const response=await readCatalog('players/history-refresh'+(resume?'/resume':''),PlayerHistoryResponseSchema,new AbortController().signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(resume?{runId:data.value!.run!.id}:{playerIds:selected,...chosen})});cache.setQueryData(target,response);}
 catch(e){if(target.join(':')===key.value.join(':'))submitError.value=e instanceof Error?e.message:'Не удалось загрузить историю.';}finally{busy.value=false;}}
</script>
<template>
 <section class="player-history" :aria-label="`Личная pro-история ${slot}`">
  <h3>Личная pro-история {{slot}}</h3>
  <p class="hint">По аккаунтам выбранных игроков, включая прежние команды. Общая карта учитывается один раз. Это ограниченная выборка OpenDota.</p>
  <label :for="`history-period-${slot}`">Период истории {{slot}}</label><select :id="`history-period-${slot}`" v-model.number="filters.windowDays" :disabled="busy||active"><option :value="90">90 дней</option><option :value="180">180 дней</option><option :value="365">1 год (365 дней)</option><option :value="730">2 года (730 дней)</option></select>
  <label :for="`history-depth-${slot}`">Глубина истории {{slot}}</label><select :id="`history-depth-${slot}`" v-model.number="filters.maxMaps" :disabled="busy||active"><option :value="10">10 карт на пятёрку</option><option :value="25">25 карт на пятёрку</option><option :value="50">50 карт на пятёрку</option></select>
  <p class="hint">Выбрано: {{filters.windowDays}} дней, до {{filters.maxMaps}} уникальных карт на всю пятёрку.</p>
  <p v-if="!valid">Сначала выберите пять различных игроков.</p>
  <p v-else-if="query.isPending.value" role="status">Проверяем доступность истории…</p>
  <p v-if="query.isError.value&&valid" role="alert">{{query.error.value?.message}} <button type="button" @click="query.refetch()">Проверить снова</button></p>
  <template v-if="data">
   <p role="status">{{data.message}}</p>
   <template v-if="data.run?.report">
    <p class="hint">Период загрузки: {{dateLabel(data.run.report.fromAt)}} — {{dateLabel(data.run.report.cutoffAt)}}.</p>
    <p>{{data.run.report.operation==='evidence_resume'?'Повторно проверено':'Принято'}} {{data.run.report.accepted}} из {{data.run.report.selected}} карт · повторных {{data.run.report.duplicates}} · исключено {{data.run.report.excluded}} · ошибок {{data.run.report.failed}} · конфликтов {{data.run.report.conflicts}}</p>
    <p v-if="data.run.report.operation==='evidence_resume'" class="hint">Проверка {{dateLabel(data.run.report.fetchedAt)}} по сохранённым проекциям OpenDota. Исходные записи и время получения сохранены отдельно; нового скачивания карт не было.</p>
    <p v-else class="hint">OpenDota · источник получен {{dateLabel(data.run.report.fetchedAt)}} · срез {{dateLabel(data.run.report.cutoffAt)}}</p>
    <p v-if="data.run.report.maps.some(m=>m.reasons.includes('STORED_PROJECTION_UNAVAILABLE'))" class="hint">Для части карт не хватает сохранённых исходных записей. Они пропущены. При необходимости используйте «Загрузить историю игроков»; повторного скачивания в этой проверке не было.</p>
    <p v-if="data.run.report.players.some(p=>p.sourceLimitReached)" class="hint">Достигнут лимит поиска для части игроков. Более ранние карты могут остаться за пределами загрузки.</p>
    <p class="hint">Для просмотра старых карт выберите соответствующее начало периода в сравнении. Период подсказок ролей остаётся 90 дней.</p>
    <details><summary>Покрытие игроков</summary><ul><li v-for="p in data.run.report.players" :key="p.playerId">Игрок {{p.playerId}} · Steam32 {{p.accountId}}: <span v-if="data.run.report.operation!=='evidence_resume'">найдено {{p.discovered}}, </span>проверено {{p.selected}}, принято {{p.accepted}}<span v-if="p.sourceLimitReached"> · достигнут лимит поиска</span></li></ul></details>
    <template v-if="data.run.report.enrichment">
     <p>Подготовка истории: подтверждено аккаунтов {{data.run.report.enrichment.accountsVerified}}, добавлено серий {{data.run.report.enrichment.seriesCreated}}. Не разрешено аккаунтов: {{data.run.report.enrichment.unresolvedAccounts.length}}.</p>
     <p v-if="data.run.report.enrichment.status!=='completed'" class="hint">Подготовка частичная: часть данных отсутствует, конфликтует или достигнут лимит обработки. Принятые карты сохранены.</p>
     <template v-if="data.run.report.enrichment.assessedAt">
      <p class="hint">Проверка истории V1: {{dateLabel(data.run.report.enrichment.assessedAt)}}. Локальные карты до этого среза, начиная с 2024 года для Elo; окно загрузки выше применяется отдельно.</p>
      <ul><li v-for="p in data.run.report.enrichment.players" :key="p.playerId">Игрок {{p.playerId}}: описательных карт {{p.rawMaps}}, допущено к истории Elo {{p.eligibleMaps}} / минимум 5.</li></ul>
      <p v-if="data.run.report.enrichment.players.some(p=>p.eligibleMaps<5)" class="hint">Для части игроков истории недостаточно. Можно выбрать большую глубину или период и повторить загрузку после указанного времени. Поиск остаётся ограниченным.</p>
     </template>
     <p v-else class="hint">Пригодность для Elo пока не оценена.</p>
     <p class="hint">Наличие истории не означает, что модель проверена и активирована.</p>
    </template>
   </template>
   <p v-if="data.retryAt&&!active" class="hint">Повторное обновление: {{dateLabel(data.retryAt)}}</p>
   <button type="button" :disabled="blocked" @click="start(false)">{{busy?'Отправляем…':active?'История загружается':'Загрузить историю игроков'}}</button>
   <button v-if="data.canResume" type="button" :disabled="blocked" @click="start(true)">Продолжить проверку загруженных карт</button>
   <p v-if="data.canResume" class="hint">Проверяет недостающие аккаунты, серии и пригодность для Elo. Поиск и скачивание карт не повторяются; может потребоваться запрос числового профиля.</p>
  </template><p v-if="submitError" role="alert">{{submitError}}</p>
 </section>
</template>
<style scoped>.player-history{margin-block:var(--space-4);padding:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-sm);overflow-wrap:anywhere}h3{margin-top:0}summary{cursor:pointer;min-height:44px}label{display:block;margin-block:var(--space-3)}select{display:block;width:100%;max-width:100%}</style>
