<script setup lang="ts">
import {computed,nextTick,ref} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {UpcomingScheduleResponseSchema,UpcomingRostersResponseSchema} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import UpcomingScenario from '../components/UpcomingScenario.vue';
const cache=useQueryClient(),selectedId=ref(''),busy=ref(false),error=ref('');
const selectedPanel=ref<HTMLElement|null>(null);
async function selectMatch(id:string){
  selectedId.value=id;error.value='';await nextTick();
  selectedPanel.value?.focus({preventScroll:true});selectedPanel.value?.scrollIntoView({block:'start',behavior:'instant'});
}
const schedule=useQuery({queryKey:['upcoming'],queryFn:({signal})=>readCatalog('upcoming',UpcomingScheduleResponseSchema,signal)});
const matches=computed(()=>(schedule.data.value?.snapshot?.data??[]).filter(m=>m.status==='not_started'&&
  (m.scheduledAt===null||m.scheduledAt>schedule.data.value!.computedAt)));
const selected=computed(()=>matches.value.find(m=>m.providerMatchId===selectedId.value)),tournament=computed(()=>selected.value?.tournament.providerTournamentId??'');
const rosters=useQuery({queryKey:computed(()=>['upcoming-rosters',tournament.value]),enabled:computed(()=>!!tournament.value),
  queryFn:({signal})=>readCatalog(`upcoming/tournaments/${tournament.value}`,UpcomingRostersResponseSchema,signal)});
const expected=computed(()=>selected.value?.opponents.map(t=>({...t,players:rosters.data.value?.snapshot?.data.find(r=>r.providerTeamId===t.providerTeamId)?.players??null}))??[]);
const moscow=(value:string|null)=>value?new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Moscow'}).format(new Date(value))+' МСК':'Время не объявлено';
const message=(reason:string|null|undefined)=>({not_configured:'Источник расписания не настроен на сервере.',
  source_unavailable:'Не удалось обновить источник. Сохранённые данные показаны ниже.',refresh_in_progress:'Обновление уже выполняется. Перечитайте сохранённые данные через несколько секунд.',
  cooldown:'Повторное обновление пока недоступно.',invalid_cached_data:'Сохранённые данные требуют обновления.',not_loaded:'Данные ещё не загружены.'}[reason??'']??'');
async function refresh(kind:'schedule'|'rosters'){
  busy.value=true;error.value='';const id=tournament.value;
  try{
    const init={method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'};
    if(kind==='schedule')cache.setQueryData(['upcoming'],await readCatalog('upcoming/refresh',UpcomingScheduleResponseSchema,new AbortController().signal,init));
    else cache.setQueryData(['upcoming-rosters',id],await readCatalog(`upcoming/tournaments/${id}/refresh`,UpcomingRostersResponseSchema,new AbortController().signal,init));
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось обновить данные.';}finally{busy.value=false;}
}
</script>
<template>
  <main class="shell upcoming"><RouterLink to="/">← Личный кабинет</RouterLink>
    <p class="eyebrow">DOTA 2 · РАСПИСАНИЕ</p><h1>Предстоящие матчи</h1>
    <p>Выберите встречу, сверьте ожидаемые составы и подготовьте свой сценарий одной карты.</p>
    <section class="panel" aria-label="Расписание встреч">
      <div class="account-row"><h2>Ближайшие встречи</h2>
        <button :disabled="busy||!schedule.data.value?.configured" @click="refresh('schedule')">{{busy?'Обновление…':'Обновить расписание'}}</button></div>
      <p class="hint">Источник: PandaScore · первая страница, до 20 встреч. Время в расписании — московское. Источник обновляется не чаще раза в пять минут.</p>
      <p v-if="schedule.isPending.value" role="status">Загрузка расписания…</p>
      <div v-else-if="schedule.error.value" role="alert"><p class="error">{{schedule.error.value.message}}</p><button @click="schedule.refetch()">Повторить чтение</button></div>
      <template v-if="schedule.data.value">
        <p v-if="schedule.data.value.reason" :class="schedule.data.value.reason==='source_unavailable'?'error':'hint'" role="status">{{message(schedule.data.value.reason)}}</p>
        <p v-if="schedule.data.value.snapshot" class="hint">Получено: {{dateLabel(schedule.data.value.snapshot.source.fetchedAt)}} · В ответе: {{schedule.data.value.snapshot.data.length}} · Будущих на странице: {{matches.length}}</p>
        <p v-if="schedule.data.value.status==='stale'" class="warning">Сохранённое расписание устарело. Время и участники могли измениться.</p>
        <p v-if="schedule.data.value.retryAt" class="hint">Повторить после {{dateLabel(schedule.data.value.retryAt)}}</p>
        <p v-if="!matches.length">Предстоящих встреч в сохранённых данных нет. Обновите расписание.</p>
        <div v-else class="table-scroll"><table><caption class="sr-only">Предстоящие встречи Dota 2</caption>
          <thead><tr><th scope="col">Начало</th><th scope="col">Встреча</th><th scope="col">Турнир</th><th scope="col">Формат</th></tr></thead>
          <tbody><tr v-for="m in matches" :key="m.providerMatchId" :class="{chosen:selectedId===m.providerMatchId}">
            <td>{{moscow(m.scheduledAt)}}</td><td><span class="match-name">{{m.opponents.map(t=>t.name??'Команда не определена').join(' — ')||m.name||'Участники не определены'}}</span>
              <button :aria-pressed="selectedId===m.providerMatchId" @click="selectMatch(m.providerMatchId)">Выбрать</button></td>
            <td>{{m.league.name??'Турнир не назван'}} · {{m.eventSeries?.name}} · {{m.tournament.name??'Стадия не указана'}}</td>
            <td>{{m.seriesBestOf?'BO'+m.seriesBestOf:'Не объявлен'}}</td>
          </tr></tbody>
        </table></div>
      </template>
    </section>
    <p v-if="error" class="error" role="alert">{{error}}</p>
    <section v-if="selected" ref="selectedPanel" class="panel" tabindex="-1" aria-label="Ожидаемые составы">
      <div class="account-row"><h2>{{selected.name??'Выбранная встреча'}}</h2><button :disabled="busy||!rosters.data.value?.configured" @click="refresh('rosters')">Обновить составы</button></div>
      <p>{{moscow(selected.scheduledAt)}} · {{selected.league.name}} · {{selected.tournament.name}}</p>
      <p>Здесь ожидаемые заявки на турнир. Поздние замены могут ещё не попасть в источник. Порядок списка не определяет роли.</p>
      <p v-if="rosters.isPending.value" role="status">Загрузка составов…</p><p v-if="rosters.error.value" class="error" role="alert">{{rosters.error.value.message}}</p>
      <template v-if="rosters.data.value">
        <p v-if="rosters.data.value.reason" class="hint" role="status">{{message(rosters.data.value.reason)}}</p>
        <p v-if="rosters.data.value.snapshot" class="hint">Источник: PandaScore · Получено: {{dateLabel(rosters.data.value.snapshot.source.fetchedAt)}}</p>
        <p v-if="rosters.data.value.status==='stale'" class="warning">Заявки устарели. Проверьте актуальный состав.</p>
        <p v-if="rosters.data.value.retryAt" class="hint">Повторить после {{dateLabel(rosters.data.value.retryAt)}}</p>
      </template>
      <div class="expected-columns"><article v-for="(t,i) in expected" :key="t.providerTeamId">
        <h3>Команда {{i===0?'A':'B'}} · {{t.name??'Не названа'}}</h3>
        <p v-if="t.players===null">Заявка ещё не загружена или отсутствует у источника.</p>
        <template v-else><p class="hint">В заявке: {{t.players.length}} игроков</p>
          <p v-if="t.players.length!==5" class="warning">Нужно вручную уточнить пятёрку.</p>
          <ul><li v-for="p in t.players" :key="p.providerPlayerId">{{p.name??'Имя не указано'}}</li></ul>
        </template>
      </article></div>
      <p v-if="expected.length!==2" class="warning">Оба соперника ещё не определены. Для сценария выберите две команды вручную.</p>
      <p class="hint">Связь этих игроков с локальной историей ещё не подтверждена. Выберите записи из справочника вручную.</p>
      <UpcomingScenario :key="selected.providerMatchId" :match="selected" />
    </section>
  </main>
</template>
<style scoped>
.expected-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-6)}article{min-width:0}article li{padding-block:4px;overflow-wrap:anywhere}
.upcoming td{vertical-align:top;min-width:130px}.chosen{background:var(--color-elevated)}.upcoming h2{overflow-wrap:anywhere}
.match-name{display:block;margin-bottom:8px}
@media(max-width:680px){.expected-columns{grid-template-columns:1fr}.upcoming{padding-inline:14px}.panel{padding:16px}}
</style>
