<script setup lang="ts">
import {computed,reactive,ref,watch,nextTick} from 'vue';
import {useRouter} from 'vue-router';
import {useQueryClient} from '@tanstack/vue-query';
import {ScenarioInputSchema,ScenarioSnapshotSchema,type UpcomingMatch} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import CatalogPicker from './CatalogPicker.vue';
import UpcomingTeamSummary from './UpcomingTeamSummary.vue';
import UpcomingLineupCompare from './UpcomingLineupCompare.vue';
import RoleSuggestions from './RoleSuggestions.vue';
import RoleProfiles from './RoleProfiles.vue';
import PlayerHistory from './PlayerHistory.vue';
import ExpectedRosterCatalogue from './ExpectedRosterCatalogue.vue';
import type {RosterCatalogueBinding} from '@dota/contracts';
import type {RosterPreparationNotice} from '../roster-preparation';
import {upcomingParticipants,upcomingProviderForSlot,upcomingTeamLabel} from '../upcoming-participants';
const props=defineProps<{match:UpcomingMatch;rosterVersion?:string}>(),router=useRouter(),cache=useQueryClient();
const manualOpen=ref(false);
const manualEditor=ref<HTMLDetailsElement|null>(null);
async function editLineups(){manualOpen.value=true;await nextTick();manualEditor.value?.querySelector('summary')?.focus();manualEditor.value?.scrollIntoView({block:'start'});}
const preparedLabels=reactive<Record<string,string>>({});
const catalogue=ref<InstanceType<typeof ExpectedRosterCatalogue>|null>(null),preparation=ref<RosterPreparationNotice[]>([]);
const automaticAllowed=computed(()=>Object.fromEntries((['A','B'] as const).map(slot=>[slot,!manualOpen.value&&!(slot==='A'?form.teamAId:form.teamBId)&&(slot==='A'?form.lineupA:form.lineupB).every(p=>!p.playerId)])) as {A:boolean;B:boolean});
function proposed(slot:'A'|'B'){return (slot==='A'?form.lineupA:form.lineupB).every(p=>!p.playerId)&&!(slot==='A'?form.teamAId:form.teamBId)?preparation.value.find(n=>n.slot===slot):undefined;}
const savedAt=reactive<Partial<Record<'A'|'B',string>>>({});
let savedRead=false;
const five=()=>Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:'',isStandin:false}));
const form=reactive({title:(props.match.name??'Сценарий встречи').slice(0,120),teamAId:'',teamBId:'',lineupA:five(),lineupB:five()});
const confirmed=ref(false),busy=ref(false),error=ref('');
const participants=computed(()=>upcomingParticipants(props.match));
function useBinding(slot:'A'|'B',binding:RosterCatalogueBinding,openEditor=true){
 preparedLabels['team:'+binding.teamId]=binding.teamName;for(const p of binding.players)preparedLabels['player:'+p.playerId]=p.name;
 const lineup=binding.players.map((p,i)=>({rolePos:i+1,playerId:p.playerId,isStandin:false}));
 if(slot==='A'){form.teamAId=binding.teamId;form.lineupA=lineup;}else{form.teamBId=binding.teamId;form.lineupB=lineup;}
 savedAt[slot]=binding.recordedAt;confirmed.value=false;if(openEditor)manualOpen.value=true;
}
function useSaved(bindings:(RosterCatalogueBinding|null)[]){
 // Hydrate once, only into an untouched editor. Refetches must never replace manual choices.
 if(savedRead)return;savedRead=true;
 if(manualOpen.value||form.teamAId||form.teamBId||[...form.lineupA,...form.lineupB].some(p=>p.playerId))return;
 for(const [i,binding] of bindings.entries())if(i<2&&binding?.usable)useBinding(i===0?'A':'B',binding,false);
}
const complete=computed(()=>!!form.teamAId&&!!form.teamBId&&form.teamAId!==form.teamBId&&
 [...form.lineupA,...form.lineupB].every(p=>p.playerId)&&new Set([...form.lineupA,...form.lineupB].map(p=>p.playerId)).size===10);
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
  <section aria-label="Составы для сравнения" class="comparison-start">
    <h3>Сравнить команды</h3>
    <p class="hint">Проверьте составы, подтвердите выбор и сравните историю игроков. Сохранение сценария не требуется.</p>
    <div class="manual-columns"><article v-for="slot in (['A','B'] as const)" :key="slot" :aria-label="`Выбранный состав ${slot}`">
      <h4>{{preparedLabels['team:'+(slot==='A'?form.teamAId:form.teamBId)]??(participants.complete?upcomingTeamLabel(match.opponents[slot==='A'?0:1]!):`Команда ${slot}`)}}</h4>
      <template v-if="proposed(slot)">
        <p role="status">{{proposed(slot)!.message}}</p>
        <ul><li v-for="p in proposed(slot)!.view?.players??[]" :key="p.providerPlayerId">
          <label v-if="(proposed(slot)!.view?.players.length??0)>5" class="check-row"><input type="checkbox" :checked="p.selected" :disabled="proposed(slot)!.busy" @change="catalogue?.togglePlayer(slot,p.providerPlayerId,($event.target as HTMLInputElement).checked)" />{{p.name??'Имя не указано'}} — в пятёрку {{slot}}</label>
          <span v-else>{{p.name??'Имя не указано'}}</span>
          <span v-if="p.account" class="account-note">{{p.account.name}} · Steam32 {{p.account.id}}</span>
          <span v-if="p.account?.proMaps!==undefined" class="account-note">Локальные pro-карты: {{p.account.proMaps}}</span>
          <span v-if="p.status==='ambiguous'&&p.account&&(p.account.proMaps??0)>0" class="account-note warning">Предложен по наличию pro-истории. Проверьте аккаунт; есть другие кандидаты.</span>
          <span v-else class="account-note warning">{{p.status==='ambiguous'?'Несколько аккаунтов — выберите нужный':p.status==='conflict'?'Конфликт аккаунтов':p.reason==='external_search_deferred'?'Нужен расширенный поиск аккаунта':p.status==='source_unavailable'?'Поиск временно недоступен':'Аккаунт требует уточнения'}}</span>
        </li></ul>
        <p v-if="proposed(slot)!.error" role="alert" class="error">{{proposed(slot)!.error}}</p>
        <button v-if="proposed(slot)!.view?.canUse" type="button" :disabled="proposed(slot)!.busy" @click="catalogue?.usePrepared(slot)">{{proposed(slot)!.busy?'Сохраняем…':`Подтвердить аккаунты и выбрать пятёрку ${slot}`}}</button>
        <button v-else type="button" :disabled="proposed(slot)!.busy" @click="catalogue?.openPreparation()">Уточнить аккаунты {{slot}}</button>
      </template>
      <ul v-else><li v-for="p in (slot==='A'?form.lineupA:form.lineupB)" :key="p.rolePos"><span class="hint">{{p.rolePos}} · </span>{{preparedLabels['player:'+p.playerId]??(p.playerId?`Игрок ${p.playerId}`:'Игрок не выбран')}}<span v-if="p.isStandin"> · замена</span></li></ul>
      <p class="hint">Выбрано {{(slot==='A'?form.lineupA:form.lineupB).filter(p=>p.playerId).length}} / 5<span v-if="savedAt[slot]"> · связи сохранены {{dateLabel(savedAt[slot]!)}}</span></p>
    </article></div>
    <p v-if="!complete" class="warning">Для сравнения нужны две пятёрки. Подготовленные игроки и причины незаполненных составов показаны в карточках выше.</p>
    <p class="hint">Сохранённые составы — ваш исходный выбор, участие в этой встрече не гарантировано. Заменить игрока и уточнить позиции можно ниже.</p>
    <button type="button" @click="editLineups">Изменить игроков и роли</button>
    <label class="check-row"><input v-model="confirmed" type="checkbox" />Подтверждаю выбранных игроков и роли для одной карты</label>
    <UpcomingLineupCompare :input="busy?null:comparisonInput" :player-labels="preparedLabels" />
  </section>
  <ExpectedRosterCatalogue v-if="participants.complete" ref="catalogue" :match-id="match.providerMatchId" :roster-version="rosterVersion" :automatic-allowed="automaticAllowed" @apply="useBinding" @saved="useSaved" @preparation="preparation=$event" />
  <details ref="manualEditor" class="manual-scenario" :open="manualOpen" @toggle="manualOpen=($event.target as HTMLDetailsElement).open"><summary>Выбрать игроков для анализа одной карты</summary>
    <p>Задайте игроков и их роли по локальному справочнику. Заявка турнира служит ориентиром; состав сценария подтверждаете вы.</p>
    <p class="hint">Найдите запись по имени или ID и выберите её из списка. Если записи нет в локальной базе, состав остаётся неполным.</p>
    <p v-if="!participants.complete" class="warning">Это гипотетический сценарий с выбранными вами командами. Он не подтверждает участников этой встречи и не привязывает к ней реальный прогноз.</p>
    <form @submit.prevent="create"><fieldset :disabled="busy" class="scenario-fields">
      <label>Название сценария<input v-model="form.title" maxlength="120" required @input="confirmed=false" /></label>
      <div class="manual-columns"><fieldset v-for="slot in (['A','B'] as const)" :key="slot">
        <legend>Команда {{slot}} · {{participants.complete?upcomingTeamLabel(match.opponents[slot==='A'?0:1]!):'выберите вручную'}}</legend>
        <CatalogPicker v-if="slot==='A'" v-model="form.teamAId" kind="teams" label="Команда A в локальной базе" :selected-label="preparedLabels['team:'+form.teamAId]" :excluded-ids="[form.teamBId]" @selected="p=>preparedLabels['team:'+p.id]=p.name??p.id" />
        <CatalogPicker v-else v-model="form.teamBId" kind="teams" label="Команда B в локальной базе" :selected-label="preparedLabels['team:'+form.teamBId]" :excluded-ids="[form.teamAId]" @selected="p=>preparedLabels['team:'+p.id]=p.name??p.id" />
        <UpcomingTeamSummary v-if="slot==='A'?form.teamAId:form.teamBId" :key="slot+':'+(slot==='A'?form.teamAId:form.teamBId)"
          :team-id="slot==='A'?form.teamAId:form.teamBId" :side-label="slot" />
        <div v-for="p in slot==='A'?form.lineupA:form.lineupB" :key="p.rolePos">
          <CatalogPicker v-model="p.playerId" kind="players" :label="`${slot}: игрок роли ${p.rolePos}`" :selected-label="preparedLabels['player:'+p.playerId]" :excluded-ids="usedPlayers(p)" @selected="item=>preparedLabels['player:'+item.id]=item.name??item.id" />
          <label class="check-row"><input v-model="p.isStandin" type="checkbox" @change="confirmed=false" />{{slot}}: замена роли {{p.rolePos}}</label>
        </div>
        <PlayerHistory :slot="slot" :player-ids="(slot==='A'?form.lineupA:form.lineupB).map(p=>p.playerId)" />
        <component :is="(slot==='A'?form.teamAId:form.teamBId)?RoleProfiles:RoleSuggestions" :key="slot+':roles:'+(slot==='A'?form.teamAId:form.teamBId)"
          :team-id="slot==='A'?form.teamAId:form.teamBId" :panda-tournament-id="match.tournament.providerTournamentId" :panda-team-id="upcomingProviderForSlot(match,slot)"
          :lineup="slot==='A'?form.lineupA:form.lineupB" :slot="slot" :preserve-manual="confirmed||!!savedAt[slot]" :player-labels="preparedLabels"
          @apply="rows=>{if(slot==='A')form.lineupA=rows.map(p=>({...p,playerId:p.playerId??''}));else form.lineupB=rows.map(p=>({...p,playerId:p.playerId??''}));}" />
      </fieldset></div>
      <p v-if="form.teamAId&&form.teamBId"><RouterLink :to="{path:'/compare',query:{teamA:form.teamAId,teamB:form.teamBId}}">Открыть сравнение организаций →</RouterLink></p>
      <p class="hint">Команды A/B не назначают Radiant/Dire. Герои и номер карты будут доступны в редакторе сценария.</p>
      <p class="hint">Период и фильтры сравнения не переносятся в сценарий. Его срез фиксируется при сохранении; период отчёта выбирается отдельно.</p>
      <button type="submit" :disabled="!input.success">{{busy?'Создание…':'Создать ручной сценарий'}}</button>
    </fieldset></form><p v-if="error" class="error" role="alert">{{error}}</p>
  </details>
</template>
<style scoped>
.manual-scenario{margin-top:var(--space-6);border-top:1px solid var(--color-border);padding-top:var(--space-4)}summary{cursor:pointer;min-height:44px}
.manual-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin-block:var(--space-4)}
.comparison-start{overflow-wrap:anywhere}.comparison-start article{min-width:0;background:var(--color-elevated);padding:var(--space-4);border-radius:var(--radius-sm)}.comparison-start h4{margin:0 0 8px}.comparison-start ul{margin:0;padding-left:20px}.comparison-start li{padding-block:3px}
.account-note{display:block;font-size:12px;color:var(--color-muted);margin-block:4px}.account-note.warning{color:var(--color-warning)}.comparison-start button{max-width:100%;white-space:normal}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}.scenario-fields{border:0;padding:0}
label{display:block}.check-row{display:flex;gap:8px;align-items:center;font-size:14px}.check-row input{width:20px;min-height:24px;flex-shrink:0}
@media(max-width:680px){.manual-columns{grid-template-columns:1fr}}
</style>
