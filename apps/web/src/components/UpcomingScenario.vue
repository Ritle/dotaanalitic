<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useRouter} from 'vue-router';
import {useQueryClient} from '@tanstack/vue-query';
import {ScenarioInputSchema,ScenarioSnapshotSchema,type UpcomingMatch} from '@dota/contracts';
import {readCatalog} from '../catalog';
import {ownerAuth} from '../auth';
import CatalogPicker from './CatalogPicker.vue';
const props=defineProps<{match:UpcomingMatch}>(),router=useRouter(),cache=useQueryClient();
const five=()=>Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:'',isStandin:false}));
const form=reactive({title:(props.match.name??'Сценарий встречи').slice(0,120),teamAId:'',teamBId:'',lineupA:five(),lineupB:five()});
const confirmed=ref(false),busy=ref(false),error=ref('');
watch(form,()=>{confirmed.value=false;},{deep:true,flush:'sync'});
const usedPlayers=(current:typeof form.lineupA[number])=>[...form.lineupA,...form.lineupB].filter(p=>p!==current&&p.playerId).map(p=>p.playerId);
const input=computed(()=>ScenarioInputSchema.safeParse({...form,cutoffAt:new Date().toISOString(),scheduledAt:props.match.scheduledAt,
  confirmedByOwner:confirmed.value,expectedLineupA:null,expectedLineupB:null,
  context:{seriesId:null,leagueId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,
    firstPickSlot:null,venueKind:null,tournamentStage:null}}));
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
  <details class="manual-scenario"><summary>Выбрать игроков для анализа одной карты</summary>
    <p>Задайте игроков и их роли по локальному справочнику. Заявка турнира служит ориентиром; состав сценария подтверждаете вы.</p>
    <p class="hint">Найдите запись по имени или ID и выберите её из списка. Если записи нет в локальной базе, состав остаётся неполным.</p>
    <form @submit.prevent="create"><fieldset :disabled="busy" class="scenario-fields">
      <label>Название сценария<input v-model="form.title" maxlength="120" required @input="confirmed=false" /></label>
      <div class="manual-columns"><fieldset v-for="slot in (['A','B'] as const)" :key="slot">
        <legend>Команда {{slot}} · {{match.opponents[slot==='A'?0:1]?.name??'не определена'}}</legend>
        <CatalogPicker v-if="slot==='A'" v-model="form.teamAId" kind="teams" label="Команда A в локальной базе" :excluded-ids="[form.teamBId]" />
        <CatalogPicker v-else v-model="form.teamBId" kind="teams" label="Команда B в локальной базе" :excluded-ids="[form.teamAId]" />
        <div v-for="p in slot==='A'?form.lineupA:form.lineupB" :key="p.rolePos">
          <CatalogPicker v-model="p.playerId" kind="players" :label="`${slot}: игрок роли ${p.rolePos}`" :excluded-ids="usedPlayers(p)" />
          <label class="check-row"><input v-model="p.isStandin" type="checkbox" @change="confirmed=false" />{{slot}}: замена роли {{p.rolePos}}</label>
        </div>
      </fieldset></div>
      <label class="check-row"><input v-model="confirmed" type="checkbox" required />Подтверждаю выбранных игроков и роли для одной карты</label>
      <p class="hint">Команды A/B не назначают Radiant/Dire. Герои и номер карты будут доступны в редакторе сценария.</p>
      <button type="submit" :disabled="!input.success">{{busy?'Создание…':'Создать ручной сценарий'}}</button>
    </fieldset></form><p v-if="error" class="error" role="alert">{{error}}</p>
  </details>
</template>
<style scoped>
.manual-scenario{margin-top:var(--space-6);border-top:1px solid var(--color-border);padding-top:var(--space-4)}summary{cursor:pointer;min-height:44px}
.manual-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin-block:var(--space-4)}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}.scenario-fields{border:0;padding:0}
label{display:block}.check-row{display:flex;gap:8px;align-items:center;font-size:14px}.check-row input{width:20px;min-height:24px;flex-shrink:0}
@media(max-width:680px){.manual-columns{grid-template-columns:1fr}}
</style>
