<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {DraftNativeRequestSchema,DraftNativeSavedSchema,DraftNativeStateSchema} from '../../../api/src/modules/scenarios/draft-native-contract';
import {readCatalog,CatalogRequestError,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{scenarioId:string;revision:number;captureId:string;dirty:boolean}>();
const cache=useQueryClient(),key=['draft-native-binding',props.captureId],path=`scenarios/${props.scenarioId}/draft-captures/${props.revision}/native-binding`;
const query=useQuery({queryKey:key,queryFn:({signal})=>readCatalog(path,DraftNativeStateSchema,signal),retry:false,refetchOnWindowFocus:false});
const matchId=ref(''),busy=ref(false),error=ref('');let request:{requestId:string;matchId:string}|null=null,disposed=false;
const controller=new AbortController();onBeforeUnmount(()=>{disposed=true;controller.abort();});
watch(()=>query.data.value,data=>{if(!matchId.value&&data?.latestAttempt)matchId.value=data.latestAttempt.result.matchId;});
const binding=computed(()=>query.data.value?.binding),attempt=computed(()=>query.data.value?.latestAttempt);
const valid=computed(()=>DraftNativeRequestSchema.safeParse({requestId:'123e4567-e89b-42d3-a456-426614174000',matchId:matchId.value.trim()}).success);
const labels:Record<string,string>={LOCAL_MAP_MISSING:'Этой карты ещё нет в локальной истории. Обновите профессиональную историю команд и повторите проверку.',
  PRO_MAP_SOURCE_UNVERIFIED:'Профессиональный статус или завершённый результат карты пока не подтверждён.',
  TEAM_SIDES_MISMATCH:'В карте указаны другие команды.',DRAFT_PARTICIPANTS_MISMATCH:'Игроки, герои или стороны карты не совпадают со снимком.',
  CAPTURE_PLAYERS_UNRESOLVED:'В этом снимке не определены все десять аккаунтов и героев. Сохраните исправленный драфт новой редакцией.',
  ACTUAL_PLAYERS_INCOMPLETE:'В истории карты нет полной проверенной десятки игроков и героев.',
  ACTUAL_PLAYERS_SOURCE_MISMATCH:'Сохранённые участники карты расходятся с исходными данными.',
  RECEIPT_UNVERIFIED:'Не удалось подтвердить источник карты.',RECEIPT_CONTEXT_MISMATCH:'Идентификатор или время карты расходятся с источником.',
  CAPTURE_CLOCK_INCONSISTENT:'Временные отметки снимка не прошли проверку.',MATCH_ID_MISMATCH:'Получена другая карта.'};
async function check(){
  if(!valid.value||busy.value||props.dirty||binding.value||disposed)return;
  busy.value=true;error.value='';const id=matchId.value.trim();
  if(!request||request.matchId!==id)request={requestId:crypto.randomUUID(),matchId:id};
  try{
    const saved=await readCatalog(path,DraftNativeSavedSchema,controller.signal,{method:'POST',
      headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(request)});
    if(!disposed){cache.setQueryData(key,{binding:saved.result.status==='verified'?saved:null,latestAttempt:saved});request=null;}
  }catch(e){if(!disposed)error.value=e instanceof CatalogRequestError&&e.status===409?
    'У снимка уже есть другая проверенная карта. Обновите состояние проверки.':
    'Не удалось проверить карту. Повторите запрос — сохранённый результат не будет продублирован.';}
  finally{if(!disposed)busy.value=false;}
}
</script>
<template>
  <section class="native-binding" aria-label="Проверка фактической карты" :aria-busy="busy||query.isFetching.value">
    <p v-if="query.isFetching.value" role="status">Читаем проверку карты…</p>
    <template v-else-if="binding">
      <p role="status">Карта {{binding.result.matchId}} проверена: игроки, герои и стороны совпали.</p>
      <p class="hint">Проверено {{dateLabel(binding.recordedAt)}}. Повторно указывать карту не нужно.</p>
      <p v-if="binding.result.temporalStatus==='not_before_provider_start'" class="warning">Снимок сохранён не раньше указанного источником начала карты.</p>
      <p class="hint">Это сверка с сыгранной картой. Номер в серии и точный игровой старт ещё не подтверждены; прогноз после драфта не включён.</p>
    </template>
    <details v-else>
      <summary>Связать снимок с сыгранной картой</summary>
      <p class="hint">Укажите Dota match ID завершённой карты из OpenDota или STRATZ. Проверка использует локальную профессиональную историю.</p>
      <form @submit.prevent="check">
        <label :for="'native-map-'+captureId">Dota match ID</label>
        <div class="native-controls"><input :id="'native-map-'+captureId" v-model="matchId" inputmode="numeric" maxlength="19" autocomplete="off" :disabled="busy||dirty" />
          <button type="submit" :disabled="!valid||busy||dirty||query.isFetching.value||!!query.error.value">{{busy?'Проверяем карту…':'Проверить карту'}}</button></div>
      </form>
      <p v-if="dirty" class="hint">Сохраните изменения драфта перед проверкой новой редакции.</p>
      <template v-if="attempt&&attempt.result.status==='unavailable'">
        <p role="status">Карта {{attempt.result.matchId}} пока не подтверждена.</p>
        <ul class="warning"><li v-for="reason in attempt.result.reasons" :key="reason">{{labels[reason]??'Данные карты не прошли проверку.'}}</li></ul>
        <p class="hint">Проверено {{dateLabel(attempt.recordedAt)}}. После обновления истории можно проверить снова.</p>
      </template>
    </details>
    <template v-if="error||query.error.value">
      <p role="alert" class="error">{{error||'Не удалось прочитать проверку карты.'}}</p>
      <button type="button" :disabled="busy||query.isFetching.value" @click="error='';query.refetch()">Обновить состояние проверки</button>
    </template>
  </section>
</template>
<style scoped>
.native-binding{margin-top:12px;border-top:1px solid var(--color-border);padding-top:8px;overflow-wrap:anywhere}
.native-binding summary{cursor:pointer;min-height:44px;display:flex;align-items:center}.native-controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.native-controls input{min-width:0;flex:1 1 140px;width:100%;box-sizing:border-box}.native-controls button{white-space:normal}
</style>
