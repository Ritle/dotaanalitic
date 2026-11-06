<script setup lang="ts">
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {V1ScheduleTargetPreviewSchema,V1ScheduleTargetHistorySchema,V1ScheduleTargetRequestSchema,V1ScheduleTargetSavedSchema,
  type V1ScheduleTargetRequest,type UpcomingMatch} from '@dota/contracts';
import {scheduleTargetCall} from '../schedule-targets';
import {dateLabel} from '../catalog';
import CatalogPicker from './CatalogPicker.vue';
import ScheduleTargetDetails from './ScheduleTargetDetails.vue';
import ScheduleFreshness from './ScheduleFreshness.vue';
import {upcomingParticipants,upcomingTeamLabel} from '../upcoming-participants';
const props=defineProps<{match:UpcomingMatch}>(),cache=useQueryClient(),open=ref(false),busy=ref(false),error=ref(''),conflict=ref(false),fresh=ref(false);
const preview=useQuery({queryKey:computed(()=>['schedule-target-preview',props.match.providerMatchId]),enabled:open,
  queryFn:({signal})=>scheduleTargetCall(`upcoming/${props.match.providerMatchId}/target-preview`,V1ScheduleTargetPreviewSchema,signal)});
const history=useQuery({queryKey:computed(()=>['schedule-target-history',props.match.providerMatchId]),enabled:open,
  queryFn:({signal})=>scheduleTargetCall(`upcoming/${props.match.providerMatchId}/targets`,V1ScheduleTargetHistorySchema,signal)});
const form=reactive({providerTeamAId:'',teamAId:'',teamBId:'',leagueId:'',reviewSourceUrl:'',reason:'',confirmed:false});
watch(()=>[preview.data.value?.observation.id,history.data.value?.items[0]?.record.revision],()=>{form.confirmed=false;},{flush:'sync'});
const pending=ref<V1ScheduleTargetRequest|null>(null),saved=ref<ReturnType<typeof V1ScheduleTargetSavedSchema.parse>|null>(null);
const opponents=computed(()=>preview.data.value?.observation.match.opponents??[]);
const completeParticipants=computed(()=>upcomingParticipants(props.match).complete);
const participantB=computed(()=>completeParticipants.value&&opponents.value.length===2&&opponents.value.some(t=>t.providerTeamId===form.providerTeamAId)?
  opponents.value.find(t=>t.providerTeamId!==form.providerTeamAId):undefined);
const providerB=computed(()=>participantB.value?.providerTeamId??'');
let active:AbortController|null=null;onBeforeUnmount(()=>active?.abort());
async function refresh(){await Promise.all([preview.refetch(),history.refetch()]);form.confirmed=false;}
async function submit(retry=false){
  if(busy.value)return;error.value='';conflict.value=false;let body=retry?pending.value:null;
  if(!body)try{
    if(!completeParticipants.value||!form.confirmed||!fresh.value||!preview.data.value?.eligible||!history.data.value)throw Error();
    body=V1ScheduleTargetRequestSchema.parse({requestId:crypto.randomUUID(),providerMatchId:props.match.providerMatchId,
      observationId:preview.data.value.observation.id,observationSha256:preview.data.value.observation.snapshotSha256,
      expectedRevision:history.data.value.items[0]?.record.revision??0,mapNumber:1,providerTeamAId:form.providerTeamAId,providerTeamBId:providerB.value,
      teamAId:form.teamAId,teamBId:form.teamBId,leagueId:form.leagueId.trim()||null,reviewSourceUrl:form.reviewSourceUrl.trim(),reason:form.reason});
  }catch{error.value='Уточните участников, две локальные команды, HTTPS-источник и обоснование (от 20 символов), затем подтвердите выбор.';return;}
  const controller=new AbortController();active=controller;pending.value=body;busy.value=true;
  try{const result=await scheduleTargetCall('schedule-targets',V1ScheduleTargetSavedSchema,controller.signal,body);if(controller.signal.aborted)return;
    saved.value=result;pending.value=null;form.confirmed=false;await cache.invalidateQueries({queryKey:['schedule-target-history',props.match.providerMatchId]});}
  catch(e){if(controller.signal.aborted)return;error.value=e instanceof Error?e.message:'Не удалось сохранить назначение.';
    conflict.value=e instanceof Error&&'status' in e&&e.status===409;
  }finally{busy.value=false;}
}
</script>
<template>
  <details class="target" @toggle="open=($event.target as HTMLDetailsElement).open"><summary>Зафиксировать назначение первой карты</summary>
    <p>Сохраните встречу до начала игры. Это отдельная запись назначения, пока без вероятности и связи с сыгранной картой.</p>
    <ScheduleFreshness v-if="open" :match-id="match.providerMatchId" @eligible="fresh=$event" />
    <p v-if="preview.isFetching.value||history.isFetching.value" role="status">Загрузка сохранённого источника…</p>
    <p v-if="preview.error.value||history.error.value" role="alert">{{preview.error.value?.message??history.error.value?.message}}</p>
    <template v-if="preview.data.value">
      <p>По источнику: {{preview.data.value.observation.match.name??'Встреча'}} · {{dateLabel(preview.data.value.observation.match.scheduledAt)}}. Получено {{dateLabel(preview.data.value.observation.fetchedAt)}}.</p>
      <p v-if="!completeParticipants||preview.data.value.reasons.some(r=>!r.startsWith('SCHEDULE_SOURCE_'))" class="warning">Нужны два определённых участника, будущее время начала и статус предстоящей встречи. Обновите расписание.</p>
      <p v-if="preview.data.value.omittingLaterPages" class="warning">Более поздние частичные ответы не содержат эту встречу. Проверьте актуальность по источнику; отсутствие не означает отмену.</p>
      <form @submit.prevent="submit()"><fieldset :disabled="busy||!fresh||!completeParticipants||!preview.data.value.eligible||!history.data.value">
        <label for="target-provider-a">Участник источника для команды A</label><select id="target-provider-a" v-model="form.providerTeamAId" required @change="form.confirmed=false">
          <option value="">Выберите участника</option><option v-for="team in opponents" :key="team.providerTeamId" :value="team.providerTeamId">{{team.name??team.providerTeamId}}</option></select>
        <p>Участник B: {{participantB?upcomingTeamLabel(participantB):'не выбран'}}.</p>
        <CatalogPicker v-model="form.teamAId" kind="teams" label="Назначение: локальная команда A" :excluded-ids="[form.teamBId]" @update:model-value="form.confirmed=false" />
        <CatalogPicker v-model="form.teamBId" kind="teams" label="Назначение: локальная команда B" :excluded-ids="[form.teamAId]" @update:model-value="form.confirmed=false" />
        <label>ID локального турнира · необязательно<input v-model="form.leagueId" inputmode="numeric" @input="form.confirmed=false" /></label>
        <label>Источник сопоставления · HTTPS<input v-model="form.reviewSourceUrl" type="url" maxlength="2048" required @input="form.confirmed=false" /></label>
        <label>Обоснование сопоставления<textarea v-model="form.reason" minlength="20" maxlength="1000" required @input="form.confirmed=false" /></label>
        <label class="check"><input v-model="form.confirmed" type="checkbox" required />Подтверждаю соответствие участников и назначение карты 1</label>
        <button type="submit">{{busy?'Сохранение…':'Сохранить назначение карты 1'}}</button>
      </fieldset></form>
    </template>
    <p v-if="error" role="alert" class="error">{{error}}</p>
    <button v-if="pending&&!busy&&!conflict" @click="submit(true)">Повторить сохранение того же назначения</button>
    <button :disabled="busy" @click="refresh">Перечитать источник и историю</button>
    <template v-if="saved"><ScheduleTargetDetails :saved="saved" /><RouterLink :to="`/schedule-targets/${saved.record.request.requestId}`">Открыть сохранённое назначение →</RouterLink></template>
    <ul v-if="history.data.value?.items.length" aria-label="Последние назначения встречи"><li v-for="item in history.data.value.items" :key="item.record.request.requestId">
      <RouterLink :to="`/schedule-targets/${item.record.request.requestId}`">Редакция {{item.record.revision}} · {{dateLabel(item.record.selectedAt)}}</RouterLink>
    </li></ul>
    <p v-if="history.data.value?.nextBeforeRevision">Показаны последние 20 редакций встречи.</p>
  </details>
</template>
<style scoped>
.target{margin-top:var(--space-6);overflow-wrap:anywhere}summary{cursor:pointer;min-height:44px}fieldset{min-width:0;border:1px solid var(--color-border);padding:var(--space-4)}label{display:block;margin-block:var(--space-3)}.check{display:flex;gap:8px;align-items:center}.check input{width:20px;min-height:24px;flex-shrink:0}button{margin-top:var(--space-3)}
textarea{display:block;width:100%;min-width:0;min-height:112px;margin-top:var(--space-2);padding:var(--space-3) var(--space-4);font:inherit;font-weight:400;color:var(--color-text);background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--radius-sm);resize:vertical}
</style>
