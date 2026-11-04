<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useRouter} from 'vue-router';
import {useQueryClient} from '@tanstack/vue-query';
import {ScenarioInputSchema,ScenarioSnapshotSchema,type UpcomingMatch} from '@dota/contracts';
import {readCatalog} from '../catalog';
import {ownerAuth} from '../auth';
import CatalogPicker from './CatalogPicker.vue';
import UpcomingTeamSummary from './UpcomingTeamSummary.vue';
import UpcomingLineupCompare from './UpcomingLineupCompare.vue';
import RoleSuggestions from './RoleSuggestions.vue';
import RoleProfiles from './RoleProfiles.vue';
import ExpectedRosterCatalogue from './ExpectedRosterCatalogue.vue';
import type {RosterCatalogueBinding} from '@dota/contracts';
import {upcomingParticipants,upcomingProviderForSlot,upcomingTeamLabel} from '../upcoming-participants';
const props=defineProps<{match:UpcomingMatch;rosterVersion?:string}>(),router=useRouter(),cache=useQueryClient();
const manualOpen=ref(false);
const preparedLabels=reactive<Record<string,string>>({});
const five=()=>Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:'',isStandin:false}));
const form=reactive({title:(props.match.name??'Сценарий встречи').slice(0,120),teamAId:'',teamBId:'',lineupA:five(),lineupB:five()});
const confirmed=ref(false),busy=ref(false),error=ref('');
const participants=computed(()=>upcomingParticipants(props.match));
function useBinding(slot:'A'|'B',binding:RosterCatalogueBinding){
 preparedLabels['team:'+binding.teamId]=binding.teamName;for(const p of binding.players)preparedLabels['player:'+p.playerId]=p.name;
 const lineup=binding.players.map((p,i)=>({rolePos:i+1,playerId:p.playerId,isStandin:false}));
 if(slot==='A'){form.teamAId=binding.teamId;form.lineupA=lineup;}else{form.teamBId=binding.teamId;form.lineupB=lineup;}
 confirmed.value=false;manualOpen.value=true;
}
watch(form,()=>{confirmed.value=false;},{deep:true,flush:'sync'});
const usedPlayers=(current:typeof form.lineupA[number])=>[...form.lineupA,...form.lineupB].filter(p=>p!==current&&p.playerId).map(p=>p.playerId);
const input=computed(()=>ScenarioInputSchema.safeParse({...form,cutoffAt:new Date().toISOString(),scheduledAt:props.match.scheduledAt,
  confirmedByOwner:confirmed.value,expectedLineupA:null,expectedLineupB:null,
  context:{seriesId:null,leagueId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,
    firstPickSlot:null,venueKind:null,tournamentStage:null}}));
const comparisonInput=computed(()=>{const q=input.value;return q.success?{
  teamAId:q.data.teamAId,teamBId:q.data.teamBId,lineupA:q.data.lineupA,lineupB:q.data.lineupB}:null;});
async function create(){
  error.value='';
  if(props.match.scheduledAt&&props.match.scheduledAt<=new Date().toISOString()){
    error.value='Плановое начало уже наступило. Обновите расписание и уточните контекст карты.';return;
  }
  if(!input.value.success){error.value='Выберите две разные организации, десять разных игроков и подтвердите роли.';return;}
  busy.value=true;
  try{
    const s=await readCatalog('scenarios',ScenarioSnapshotSchema,new AbortController().signal,{method:'POST',
      headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},
      body:JSON.stringify({...input.value.data,cutoffAt:new Date().toISOString()})});
    cache.setQueryData(['scenario',s.id],s);await cache.invalidateQueries({queryKey:['scenarios']});await router.push(`/scenarios/${s.id}`);
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось создать сценарий.';}finally{busy.value=false;}
}
</script>
<template>
  <ExpectedRosterCatalogue v-if="participants.complete" :match-id="match.providerMatchId" :roster-version="rosterVersion" @apply="useBinding" />
  <details class="manual-scenario" :open="manualOpen" @toggle="manualOpen=($event.target as HTMLDetailsElement).open"><summary>Выбрать игроков для анализа одной карты</summary>
    <p>Задайте игроков и их роли по локальному справочнику. Заявка турнира служит ориентиром; состав сценария подтверждаете вы.</p>
    <p class="hint">Найдите запись по имени или ID и выберите её из списка. Если записи нет в локальной базе, состав остаётся неполным.</p>
    <p v-if="!participants.complete" class="warning">Это гипотетический сценарий с выбранными вами командами. Он не подтверждает участников этой встречи и не привязывает к ней реальный прогноз.</p>
    <form @submit.prevent="create"><fieldset :disabled="busy" class="scenario-fields">
      <label>Название сценария<input v-model="form.title" maxlength="120" required @input="confirmed=false" /></label>
      <div class="manual-columns"><fieldset v-for="slot in (['A','B'] as const)" :key="slot">
        <legend>Команда {{slot}} · {{participants.complete?upcomingTeamLabel(match.opponents[slot==='A'?0:1]!):'выберите вручную'}}</legend>
        <CatalogPicker v-if="slot==='A'" v-model="form.teamAId" kind="teams" label="Команда A в локальной базе" :selected-label="preparedLabels['team:'+form.teamAId]" :excluded-ids="[form.teamBId]" />
        <CatalogPicker v-else v-model="form.teamBId" kind="teams" label="Команда B в локальной базе" :selected-label="preparedLabels['team:'+form.teamBId]" :excluded-ids="[form.teamAId]" />
        <UpcomingTeamSummary v-if="slot==='A'?form.teamAId:form.teamBId" :key="slot+':'+(slot==='A'?form.teamAId:form.teamBId)"
          :team-id="slot==='A'?form.teamAId:form.teamBId" :side-label="slot" />
        <div v-for="p in slot==='A'?form.lineupA:form.lineupB" :key="p.rolePos">
          <CatalogPicker v-model="p.playerId" kind="players" :label="`${slot}: игрок роли ${p.rolePos}`" :selected-label="preparedLabels['player:'+p.playerId]" :excluded-ids="usedPlayers(p)" />
          <label class="check-row"><input v-model="p.isStandin" type="checkbox" @change="confirmed=false" />{{slot}}: замена роли {{p.rolePos}}</label>
        </div>
        <component :is="(slot==='A'?form.teamAId:form.teamBId)?RoleProfiles:RoleSuggestions" :key="slot+':roles:'+(slot==='A'?form.teamAId:form.teamBId)"
          :team-id="slot==='A'?form.teamAId:form.teamBId" :panda-tournament-id="match.tournament.providerTournamentId" :panda-team-id="upcomingProviderForSlot(match,slot)"
          :lineup="slot==='A'?form.lineupA:form.lineupB" :slot="slot"
          @apply="rows=>{if(slot==='A')form.lineupA=rows.map(p=>({...p,playerId:p.playerId??''}));else form.lineupB=rows.map(p=>({...p,playerId:p.playerId??''}));}" />
      </fieldset></div>
      <p v-if="form.teamAId&&form.teamBId"><RouterLink :to="{path:'/compare',query:{teamA:form.teamAId,teamB:form.teamBId}}">Открыть сравнение организаций →</RouterLink></p>
      <label class="check-row"><input v-model="confirmed" type="checkbox" required />Подтверждаю выбранных игроков и роли для одной карты</label>
      <p class="hint">Команды A/B не назначают Radiant/Dire. Герои и номер карты будут доступны в редакторе сценария.</p>
      <p class="hint">Период и фильтры сравнения не переносятся в сценарий. Его срез фиксируется при сохранении; период отчёта выбирается отдельно.</p>
      <button type="submit" :disabled="!input.success">{{busy?'Создание…':'Создать ручной сценарий'}}</button>
    </fieldset></form><p v-if="error" class="error" role="alert">{{error}}</p>
    <UpcomingLineupCompare :input="busy?null:comparisonInput" />
  </details>
</template>
<style scoped>
.manual-scenario{margin-top:var(--space-6);border-top:1px solid var(--color-border);padding-top:var(--space-4)}summary{cursor:pointer;min-height:44px}
.manual-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin-block:var(--space-4)}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}.scenario-fields{border:0;padding:0}
label{display:block}.check-row{display:flex;gap:8px;align-items:center;font-size:14px}.check-row input{width:20px;min-height:24px;flex-shrink:0}
@media(max-width:680px){.manual-columns{grid-template-columns:1fr}}
</style>
