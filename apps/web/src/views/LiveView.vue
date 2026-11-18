<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {LiveResponseSchema,LiveMatchSchema,type LiveMatch} from '../../../api/src/modules/live/contract';
import {UpcomingRostersResponseSchema} from '@dota/contracts';
import UpcomingScenario from '../components/UpcomingScenario.vue';
import {readCatalog} from '../catalog';
import {ownerAuth,accountAccess} from '../auth';
import {liveRefreshAction} from '../live-refresh';
import {upcomingParticipants} from '../upcoming-participants';
const cache=useQueryClient(),busy=ref(false),error=ref(''),automatic=ref(true),tournament=ref('');
const owner=computed(()=>accountAccess.value?.role==='owner');
const now=ref(Date.now());
const selected=ref<LiveMatch|null>(null);
const rosterVersion=ref(''),rosterBusy=ref(false),rosterError=ref('');
async function selectMatch(match:LiveMatch){selected.value=LiveMatchSchema.parse(match);await refreshRosters();}
async function refreshRosters(){
 const match=selected.value;if(!match||rosterBusy.value)return;rosterBusy.value=true;rosterError.value='';
 try{const data=await readCatalog(`upcoming/tournaments/${match.tournament.providerTournamentId}${owner.value?'/refresh':''}`,UpcomingRostersResponseSchema,new AbortController().signal,
  owner.value?{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'}:undefined);
  if(selected.value?.providerMatchId===match.providerMatchId)rosterVersion.value=data.snapshot?.source.fetchedAt??'';
 }catch(e){rosterError.value=e instanceof Error?e.message:'Не удалось обновить заявку турнира. Можно выбрать игроков вручную.';}finally{rosterBusy.value=false;}
}
const query=useQuery({queryKey:['live-matches'],queryFn:({signal})=>readCatalog('live',LiveResponseSchema,signal),staleTime:30000,refetchOnWindowFocus:false,refetchOnReconnect:false});
let disposed=false,controller:AbortController|undefined,timer:ReturnType<typeof setInterval>|undefined,lastAttemptAt=0,lastReadAt=0;
const running=computed(()=>(query.data.value?.snapshot?.data??[]).filter(m=>m.status==='running'));
const stale=computed(()=>query.data.value?.status==='stale'||!!(query.data.value?.expiresAt&&Date.parse(query.data.value.computedAt)+Math.max(0,now.value-query.dataUpdatedAt.value)>=Date.parse(query.data.value.expiresAt)));
const eventKey=(m:(typeof running.value)[number])=>m.league.providerLeagueId+':'+(m.eventSeries?.providerEventSeriesId??'');
const events=computed(()=>[...new Map(running.value.map(m=>[eventKey(m),[m.league.name,m.eventSeries?.name].filter(Boolean).join(' · ')||'Турнир без названия'])).entries()]);
const matches=computed(()=>running.value.filter(m=>!tournament.value||eventKey(m)===tournament.value));
watch(events,items=>{if(tournament.value&&!items.some(([id])=>id===tournament.value))tournament.value='';});
const time=(value:string|null)=>value?new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Moscow'}).format(new Date(value))+' МСК':'Время не объявлено';
const messages:Record<string,string>={not_configured:'Источник не настроен.',not_loaded:'Список текущих матчей ещё не загружен.',refresh_in_progress:'Обновление уже выполняется.',cooldown:'Источник попросил подождать.',source_unavailable:'Не удалось обновить источник. Сохранённые данные могут быть устаревшими.',invalid_cached_data:'Сохранённые данные не прошли проверку.'};
const reason=computed(()=>messages[query.data.value?.reason??'']??'');
async function refresh(){
 if(busy.value||!owner.value)return;busy.value=true;error.value='';lastAttemptAt=Date.now();controller=new AbortController();
 try{await cache.cancelQueries({queryKey:['live-matches'],exact:true});
  const data=await readCatalog('live/refresh',LiveResponseSchema,controller.signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'});
  if(!disposed)cache.setQueryData(['live-matches'],data);
 }catch(e){if(!disposed)error.value=e instanceof Error?e.message:'Не удалось обновить список.';}finally{busy.value=false;}
}
async function tick(){if(disposed)return;now.value=Date.now();
 const action=liveRefreshAction({data:query.data.value,now:Date.now(),receivedAt:query.dataUpdatedAt.value||Date.now(),owner:owner.value,lastAttemptAt,lastReadAt,
  paused:!automatic.value||busy.value||query.isFetching.value||document.visibilityState!=='visible'||!navigator.onLine});
 if(action==='refresh')await refresh();else if(action==='read'){lastReadAt=Date.now();await query.refetch();}
}
watch([()=>query.data.value,query.isFetching,busy,automatic,owner],()=>void tick(),{flush:'post'});
onMounted(()=>{document.addEventListener('visibilitychange',tick);window.addEventListener('online',tick);timer=setInterval(()=>void tick(),15000);void tick();});
onBeforeUnmount(()=>{disposed=true;controller?.abort();if(timer)clearInterval(timer);document.removeEventListener('visibilitychange',tick);window.removeEventListener('online',tick);});
</script>
<template>
 <section class="shell live-page">
  <nav class="live-nav" aria-label="Разделы матчей"><RouterLink to="/">← Личный кабинет</RouterLink><RouterLink to="/upcoming">Предстоящие матчи</RouterLink><RouterLink to="/forecast-journal">Журнал прогнозов</RouterLink></nav>
  <p class="eyebrow">DOTA 2 · LIVE</p><h1>Матчи сейчас</h1>
  <p>Текущие серии: участники, турнир и счёт выигранных карт по данным PandaScore.</p>
  <section class="panel" aria-label="Текущие матчи">
   <div class="live-toolbar"><div class="live-filter"><label for="live-tournament">Турнир</label><select id="live-tournament" v-model="tournament"><option value="">Все турниры</option><option v-for="[id,name] in events" :key="id" :value="id">{{name}}</option></select></div>
    <button :disabled="busy||query.isFetching.value||!owner||!query.data.value?.configured" @click="refresh">{{busy?'Обновление…':'Обновить Live'}}</button></div>
   <label class="live-auto"><input v-model="automatic" type="checkbox" /> Автообновление раз в минуту</label>
   <p class="hint">Обновляется в активной вкладке. Статус и счёт могут поступать с задержкой; это не телеметрия отдельной карты.</p>
   <p v-if="!owner" class="hint">Вы просматриваете сохранённые данные. Обновление источника доступно владельцу.</p>
   <p v-if="query.isPending.value" role="status">Загрузка текущих матчей…</p>
   <div v-if="query.error.value" role="alert"><p class="error">{{query.error.value.message}}</p><button @click="query.refetch()">Повторить чтение</button></div>
   <p v-if="error" class="error" role="alert">{{error}}</p>
   <p v-if="reason" role="status">{{reason}}</p>
   <p v-if="query.data.value?.snapshot" class="hint">Источник: PandaScore · Получено: {{time(query.data.value.snapshot.source.fetchedAt)}} · Текущих серий: {{running.length}}</p>
   <p v-if="stale" class="warning" role="status">Данные устарели: показан последний известный статус, матчи могли завершиться.</p>
   <p v-if="query.data.value?.retryAt" class="hint">Повторить после {{time(query.data.value.retryAt)}}</p>
   <p v-if="query.data.value?.snapshot?.data.length===20" class="hint">Показаны первые 20 записей источника. Список может быть неполным.</p>
   <p v-if="query.data.value?.snapshot&&!matches.length" role="status">{{tournament?'Сейчас нет матчей выбранного турнира.':!stale?'Источник не сообщил о текущих матчах.':'В сохранённом списке нет текущих матчей.'}}</p>
   <div class="live-grid"><article v-for="m in matches" :key="m.providerMatchId" class="live-card">
    <span class="live-badge">{{!stale?'LIVE':'Последний статус: шёл'}}</span>
    <h2>{{upcomingParticipants(m).label}}</h2>
    <p class="hint">{{m.league.name??'Турнир не назван'}} · {{m.eventSeries?.name}} · {{m.tournament.name}}</p>
    <p class="live-score"><span>Счёт серии</span><strong>{{m.seriesScore?m.seriesScore.map(t=>t.wins).join(' : '):'Нет данных'}}</strong><small>{{m.seriesBestOf?'BO'+m.seriesBestOf:'Формат не объявлен'}}</small></p>
    <p class="hint">{{m.beganAt?'Началась: ':'По расписанию: '}}{{time(m.beganAt??m.scheduledAt)}}</p>
    <p v-if="!upcomingParticipants(m).complete" class="warning">Один из участников ещё не указан источником.</p>
    <button :disabled="stale||!upcomingParticipants(m).complete" @click="selectMatch(m)">Оценить пятёрки</button>
   </article></div>
  </section>
  <section v-if="selected" class="panel" aria-label="Выбранная Live-встреча"><button @click="selected=null">Закрыть оценку</button><h2>{{upcomingParticipants(selected).label}}</h2>
   <p class="warning">Условная оценка силы пятёрок. Счёт, драфт и ход текущей карты не учитываются.</p>
   <button :disabled="rosterBusy" @click="refreshRosters">{{rosterBusy?'Загружаем составы…':'Обновить составы'}}</button><p v-if="rosterError" role="alert">{{rosterError}}</p>
   <UpcomingScenario :key="selected.providerMatchId" :match="selected" :roster-version="rosterVersion" live />
  </section>
  <p class="hint">Ранее сохранённые прогнозы до начала игры доступны в <RouterLink to="/forecast-journal">журнале</RouterLink>. Условные Live-оценки хранятся отдельно.</p>
 </section>
</template>
<style scoped>
.live-auto{display:flex;align-items:center;gap:8px}.live-auto input{width:18px;height:18px;min-height:0;margin:0;flex:0 0 auto}
.live-nav,.live-toolbar{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.live-toolbar{justify-content:space-between;margin-bottom:16px}.live-toolbar select{max-width:100%}.live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px}.live-card{border:1px solid var(--color-border);border-radius:12px;padding:20px;min-width:0}.live-card h2{font-size:20px;overflow-wrap:anywhere}.live-badge{font-size:12px;color:var(--color-accent);font-weight:700}.live-score{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.live-score strong{font-size:28px}.live-score small{color:var(--color-muted)}.live-filter{min-width:0;max-width:100%}
</style>
