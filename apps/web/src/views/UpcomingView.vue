<script setup lang="ts">
import {computed,nextTick,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {SchedulePageResponseSchema,UpcomingRostersResponseSchema,SCHEDULE_PAGE_LIMIT} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import UpcomingScenario from '../components/UpcomingScenario.vue';
import UpcomingTarget from '../components/UpcomingTarget.vue';
import {upcomingParticipants,upcomingParticipantKey,upcomingTeamLabel} from '../upcoming-participants';
const cache=useQueryClient(),selectedId=ref(''),busy=ref(false),error=ref('');
const eventFilter=ref(''),page=ref(1);
const pageKey=(number:number)=>number===1?['upcoming']:['upcoming',number];
const pagePath=(number:number,refresh=false)=>`upcoming${refresh?'/refresh':''}${number===1?'':`?page=${number}`}`;
const mutation=()=>({method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'});
const selectedPanel=ref<HTMLElement|null>(null);
async function selectMatch(id:string){
  selectedId.value=id;error.value='';await nextTick();
  selectedPanel.value?.focus({preventScroll:true});selectedPanel.value?.scrollIntoView({block:'start',behavior:'instant'});
}
const schedule=useQuery({queryKey:computed(()=>pageKey(page.value)),
  queryFn:({signal,queryKey})=>readCatalog(pagePath(Number(queryKey[1]??1)),SchedulePageResponseSchema,signal),
  staleTime:60000,refetchOnWindowFocus:false,refetchOnReconnect:false});
async function changePage(number:number){
  if(busy.value||number<1||number>SCHEDULE_PAGE_LIMIT)return;
  busy.value=true;error.value='';
  try{
    const key=pageKey(number),saved=await cache.fetchQuery({queryKey:key,staleTime:60000,
      queryFn:({signal})=>readCatalog(pagePath(number),SchedulePageResponseSchema,signal)});
    if(saved.configured&&saved.reason==='not_loaded')cache.setQueryData(key,
      await readCatalog(pagePath(number,true),SchedulePageResponseSchema,new AbortController().signal,mutation()));
    selectedId.value='';eventFilter.value='';page.value=number;
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось загрузить страницу.';}finally{busy.value=false;}
}
const eventOptions=computed(()=>{
  const options=new Map<string,string>();
  for(const m of schedule.data.value?.snapshot?.data??[]){
    const id=m.tournament.providerTournamentId;
    if(!options.has(id))options.set(id,[m.league.name,m.eventSeries?.name,m.tournament.name].filter(Boolean).join(' · ')||'Турнир без названия');
  }
  return [...options].map(([id,label])=>({id,label}));
});
const upcoming=computed(()=>(schedule.data.value?.snapshot?.data??[]).filter(m=>m.status==='not_started'&&
  (m.scheduledAt===null||m.scheduledAt>schedule.data.value!.computedAt)));
const matches=computed(()=>upcoming.value.filter(m=>!eventFilter.value||m.tournament.providerTournamentId===eventFilter.value));
watch(eventFilter,()=>{selectedId.value='';error.value='';},{flush:'sync'});
watch(matches,rows=>{if(selectedId.value&&!rows.some(m=>m.providerMatchId===selectedId.value)){selectedId.value='';error.value='';}},{flush:'sync'});
const selected=computed(()=>matches.value.find(m=>m.providerMatchId===selectedId.value)),tournament=computed(()=>selected.value?.tournament.providerTournamentId??'');
const rosters=useQuery({queryKey:computed(()=>['upcoming-rosters',tournament.value]),enabled:computed(()=>!!tournament.value),
  queryFn:({signal})=>readCatalog(`upcoming/tournaments/${tournament.value}`,UpcomingRostersResponseSchema,signal)});
const participants=computed(()=>selected.value?upcomingParticipants(selected.value):null);
const expected=computed(()=>participants.value?.teams.map(t=>({...t,players:rosters.data.value?.snapshot?.data.find(r=>r.providerTeamId===t.providerTeamId)?.players??null}))??[]);
const moscow=(value:string|null)=>value?new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Moscow'}).format(new Date(value))+' МСК':'Время не объявлено';
const message=(reason:string|null|undefined)=>({not_configured:'Источник расписания не настроен на сервере.',
  source_unavailable:'Не удалось обновить источник. Сохранённые данные показаны ниже.',refresh_in_progress:'Обновление уже выполняется. Перечитайте сохранённые данные через несколько секунд.',
  cooldown:'Повторное обновление пока недоступно.',invalid_cached_data:'Сохранённые данные требуют обновления.',not_loaded:'Данные ещё не загружены.'}[reason??'']??'');
async function refresh(kind:'schedule'|'rosters'){
  busy.value=true;error.value='';const id=tournament.value;
  try{
    const init=mutation(),number=page.value;
    if(kind==='schedule')cache.setQueryData(pageKey(number),await readCatalog(pagePath(number,true),SchedulePageResponseSchema,new AbortController().signal,init));
    else cache.setQueryData(['upcoming-rosters',id],await readCatalog(`upcoming/tournaments/${id}/refresh`,UpcomingRostersResponseSchema,new AbortController().signal,init));
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось обновить данные.';}finally{busy.value=false;}
}
// Selecting a match authorizes its initial roster lookup. Existing/stale snapshots stay manual;
// errors do not cause a watch/retry loop or a request for every match in the same tournament.
const initialRosterAttempts=new Set<string>();
watch(()=>[tournament.value,busy.value,rosters.isFetching.value,rosters.data.value] as const,([id,loading,fetching,data])=>{
  if(!id||loading||fetching||!data?.configured||data.snapshot||data.reason!=='not_loaded'||initialRosterAttempts.has(id))return;
  initialRosterAttempts.add(id);void refresh('rosters');
});
</script>
<template>
  <section class="shell upcoming"><RouterLink to="/">← Личный кабинет</RouterLink>
    <p class="eyebrow">DOTA 2 · РАСПИСАНИЕ</p><h1>Предстоящие матчи</h1>
    <p>Выберите встречу, сверьте ожидаемые составы и подготовьте свой сценарий одной карты.</p>
    <section class="panel" aria-label="Расписание встреч">
      <div class="account-row"><h2>Ближайшие встречи</h2>
        <button :disabled="busy||!schedule.data.value?.configured" @click="refresh('schedule')">{{busy?'Обновление…':'Обновить расписание'}}</button></div>
      <p class="hint">Источник: PandaScore · до 20 встреч на странице. Время — московское. Каждая страница обновляется не чаще раза в пять минут.</p>
      <nav class="schedule-pages" aria-label="Страницы расписания">
        <button :disabled="busy||schedule.isFetching.value||page===1" @click="changePage(page-1)">Предыдущая страница</button>
        <span role="status">Страница {{page}}</span>
        <button :disabled="busy||schedule.isFetching.value||page===SCHEDULE_PAGE_LIMIT||schedule.data.value?.snapshot?.data.length!==20" @click="changePage(page+1)">Следующая страница</button>
      </nav>
      <p v-if="busy" role="status">Загрузка данных…</p>
      <p v-if="page===SCHEDULE_PAGE_LIMIT" class="hint">Достигнут предел просмотра — {{SCHEDULE_PAGE_LIMIT}} страниц. Полнота календаря не подтверждена.</p>
      <div class="event-filter"><label for="schedule-event-filter">Турнир в сохранённом расписании</label>
        <select id="schedule-event-filter" v-model="eventFilter" :disabled="!schedule.data.value?.snapshot" aria-describedby="event-filter-note">
          <option value="">Все турниры на этой странице</option>
          <option v-if="eventFilter&&!eventOptions.some(o=>o.id===eventFilter)" :value="eventFilter">PandaScore #{{eventFilter}} — отсутствует на странице</option>
          <option v-for="o in eventOptions" :key="o.id" :value="o.id">PandaScore #{{o.id}} · {{o.label}}</option>
        </select>
      </div>
      <p v-if="eventFilter" class="hint">Выбранный турнир: PandaScore #{{eventFilter}}.</p>
      <p id="event-filter-note" class="hint">Фильтр действует только на текущую страницу, а не на полный календарь. Он не подтверждает уровень Tier 1. При смене страницы или фильтра выбранная встреча и несохранённая форма сбрасываются. Состав страниц может меняться при обновлении источника.</p>
      <p v-if="schedule.isPending.value" role="status">Загрузка расписания…</p>
      <div v-else-if="schedule.error.value" role="alert"><p class="error">{{schedule.error.value.message}}</p><button @click="schedule.refetch()">Повторить чтение</button></div>
      <template v-if="schedule.data.value">
        <p v-if="schedule.data.value.reason" :class="schedule.data.value.reason==='source_unavailable'?'error':'hint'" role="status">{{message(schedule.data.value.reason)}}</p>
        <p v-if="schedule.data.value.snapshot" class="hint" role="status">Получено: {{dateLabel(schedule.data.value.snapshot.source.fetchedAt)}} · В ответе: {{schedule.data.value.snapshot.data.length}} · Предстоящих на странице: {{upcoming.length}} · Показано: {{matches.length}}</p>
        <p v-if="schedule.data.value.status==='stale'" class="warning">Сохранённое расписание устарело. Время и участники могли измениться.</p>
        <p v-if="schedule.data.value.retryAt" class="hint">Повторить после {{dateLabel(schedule.data.value.retryAt)}}</p>
        <p v-if="!matches.length&&eventFilter">На этой странице нет предстоящих встреч выбранного турнира. Это не означает, что их нет в полном расписании.</p>
        <p v-else-if="!matches.length">На этой странице предстоящих встреч нет. Вернитесь на предыдущую страницу или обновите расписание.</p>
        <div v-else class="table-scroll"><table><caption class="sr-only">Предстоящие встречи Dota 2</caption>
          <thead><tr><th scope="col">Начало</th><th scope="col">Встреча</th><th scope="col">Турнир</th><th scope="col">Формат</th></tr></thead>
          <tbody><tr v-for="m in matches" :key="m.providerMatchId" :class="{chosen:selectedId===m.providerMatchId}">
            <td>{{moscow(m.scheduledAt)}}</td><td><span class="match-name">{{upcomingParticipants(m).label}}</span>
              <span v-if="!upcomingParticipants(m).complete&&m.name" class="hint source-name">Запись источника: {{m.name}}</span>
              <button :aria-pressed="selectedId===m.providerMatchId" @click="selectMatch(m.providerMatchId)">Выбрать</button></td>
            <td>{{m.league.name??'Турнир не назван'}} · {{m.eventSeries?.name}} · {{m.tournament.name??'Стадия не указана'}}</td>
            <td>{{m.seriesBestOf?'BO'+m.seriesBestOf:'Не объявлен'}}</td>
          </tr></tbody>
        </table></div>
      </template>
    </section>
    <p v-if="error" class="error" role="alert">{{error}}</p>
    <section v-if="selected" ref="selectedPanel" class="panel" tabindex="-1" aria-label="Ожидаемые составы">
      <div class="account-row"><h2>{{participants?.complete?(selected.name??participants.label):participants?.label}}</h2><button :disabled="busy||!rosters.data.value?.configured" @click="refresh('rosters')">Обновить составы</button></div>
      <p>{{moscow(selected.scheduledAt)}} · {{selected.league.name}} · {{selected.tournament.name}}</p>
      <p v-if="!participants?.complete&&selected.name" class="hint">Запись источника: {{selected.name}}</p>
      <p v-if="participants?.message" class="warning" role="status">{{participants.message}}</p>
      <p v-if="!participants?.complete" class="hint">Для привязки прогноза к этой встрече нужны два разных участника источника. Команда из другой заявки турнира не подставляется вместо соперника.</p>
      <p v-if="rosters.isPending.value" role="status">Загрузка составов…</p><p v-if="rosters.error.value" class="error" role="alert">{{rosters.error.value.message}}</p>
      <template v-if="rosters.data.value">
        <p v-if="rosters.data.value.reason" class="hint" role="status">{{message(rosters.data.value.reason)}}</p>
        <p v-if="rosters.data.value.snapshot" class="hint">Источник: PandaScore · Получено: {{dateLabel(rosters.data.value.snapshot.source.fetchedAt)}}</p>
        <p v-if="rosters.data.value.status==='stale'" class="warning">Заявки устарели. Проверьте актуальный состав.</p>
        <p v-if="rosters.data.value.retryAt" class="hint">Повторить после {{dateLabel(rosters.data.value.retryAt)}}</p>
      </template>
      <UpcomingScenario :key="upcomingParticipantKey(selected)" :match="selected" :roster-version="rosters.data.value?.snapshot?.source.payloadSha256" />
      <details :open="!participants?.complete"><summary>Заявка турнира и участники источника</summary>
      <p>Здесь ожидаемые заявки на турнир. Поздние замены могут ещё не попасть в источник. Порядок списка не определяет роли.</p>
      <div class="expected-columns"><article v-for="(t,i) in expected" :key="t.providerTeamId">
        <h3>{{participants?.complete?`Команда ${i===0?'A':'B'}`:'Известный участник'}} · {{upcomingTeamLabel(t)}}</h3>
        <p class="hint">ID PandaScore: {{t.providerTeamId}}</p>
        <p v-if="t.players===null">Заявка ещё не загружена или отсутствует у источника.</p>
        <template v-else><p class="hint">В заявке: {{t.players.length}} игроков</p>
          <p v-if="t.players.length!==5" class="warning">Нужно вручную уточнить пятёрку.</p>
          <ul><li v-for="p in t.players" :key="p.providerPlayerId">{{p.name??'Имя не указано'}}</li></ul>
        </template>
      </article><article v-if="!participants?.complete" aria-label="Отсутствующий участник">
        <h3>{{expected.length===1?'Соперник не указан':'Участники не указаны'}}</h3><p>Уточните участников в источнике после обновления расписания.</p>
      </article></div>
      </details>
      <UpcomingTarget :key="'target:'+upcomingParticipantKey(selected)" :match="selected" :page="page" />
    </section>
  </section>
</template>
<style scoped>
.event-filter{display:grid;gap:var(--space-2);margin-block:var(--space-4);min-width:0}.event-filter select{width:100%;max-width:100%;min-width:0}
.expected-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-6)}article{min-width:0}article li{padding-block:4px;overflow-wrap:anywhere}
.upcoming td{vertical-align:top;min-width:130px}.chosen{background:var(--color-elevated)}.upcoming h2{overflow-wrap:anywhere}
.match-name{display:block;margin-bottom:8px}
.source-name{display:block;margin-bottom:8px}
.schedule-pages{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-block:16px}.schedule-pages button{white-space:normal}
summary{cursor:pointer;min-height:44px;padding-block:12px}
@media(max-width:680px){.expected-columns{grid-template-columns:1fr}.upcoming{padding-inline:14px}.panel{padding:16px}}
</style>
