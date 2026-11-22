<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {CatalogListSchema,type DraftInput,type ScenarioInput} from '@dota/contracts';
import DraftDisplayLabels from './DraftDisplayLabels.vue';
import ReportEntityLabel from './ReportEntityLabel.vue';
import {readCatalog} from '../catalog';
import {roleName} from '../role-suggestions';
import {heroOptionLabel} from '../hero-display';
const props=defineProps<{modelValue:DraftInput;lineupA:ScenarioInput['lineupA'];lineupB:ScenarioInput['lineupB'];playerLabels?:Record<string,string>;teamAId?:string;teamBId?:string;teamALabel?:string;teamBLabel?:string;disabled?:boolean}>();
const playerIds=computed(()=>[...props.lineupA,...props.lineupB].map(p=>p.playerId));
const selectedNames=computed(()=>!props.teamAId&&!props.teamBId&&playerIds.value.every(id=>id===null||Object.prototype.hasOwnProperty.call(props.playerLabels??{},'player:'+id))?props.playerLabels??{}:undefined);
const emit=defineEmits<{'update:modelValue':[value:DraftInput]}>();
const search=ref(''),banHero=ref(''),banSide=ref<'A'|'B'>('A'),error=ref('');
const heroes=useQuery({queryKey:computed(()=>['catalog','heroes','draft',search.value]),
  queryFn:({signal})=>readCatalog(`heroes?limit=100&query=${encodeURIComponent(search.value)}`,CatalogListSchema,signal)});
const names=ref(new Map<number,string>());
watch(()=>heroes.data.value,data=>{for(const h of data?.items??[])names.value.set(Number(h.id),h.name);},{immediate:true});
const listed=computed(()=>new Set(heroes.data.value?.items.map(h=>Number(h.id))??[]));
const picked=(slot:'A'|'B',role:number)=>props.modelValue.assignments.find(p=>p.teamSlot===slot&&p.rolePos===role)?.heroId??null;
function assign(slot:'A'|'B',rolePos:number,event:Event){
  const value=(event.target as HTMLSelectElement).value,heroId=value?Number(value):null;
  emit('update:modelValue',{...props.modelValue,assignments:[...props.modelValue.assignments.filter(p=>p.teamSlot!==slot||p.rolePos!==rolePos),...(heroId===null?[]:[{teamSlot:slot,rolePos,heroId}])]});
}
function addBan(){
  error.value='';if(!banHero.value){error.value='Выберите героя для бана.';return;}const heroId=Number(banHero.value);
  if([...props.modelValue.assignments,...props.modelValue.bans].some(h=>h.heroId===heroId)){error.value='Этот герой уже назначен или забанен.';return;}
  if(props.modelValue.bans.length>=40){error.value='Достигнут лимит размера заявки (40 банов).';return;}
  emit('update:modelValue',{...props.modelValue,bans:[...props.modelValue.bans,{teamSlot:banSide.value,heroId}]});banHero.value='';
}
</script>
<template>
  <fieldset id="draftlab" :disabled="disabled"><legend>Draft Lab · герои по игрокам и ролям</legend>

    <label>Поиск героев в локальном каталоге<input v-model="search" type="search" maxlength="80" /></label>
    <p v-if="heroes.isPending.value" role="status">Загрузка героев…</p><p v-else-if="heroes.error.value" class="error" role="alert">{{heroes.error.value.message}} <button type="button" @click="heroes.refetch()">Повторить загрузку героев</button></p>
    <p v-else-if="!heroes.data.value?.items.length">Герои по запросу не найдены. Измените поиск или синхронизируйте каталог.</p>
    <p v-if="heroes.data.value?.hasMore" class="hint">Показаны первые100 героев. Уточните поиск по имени или ID.</p>
    <DraftDisplayLabels :provided-labels="selectedNames" :player-ids="playerIds" :team-ids="[teamAId??null,teamBId??null]" compact v-slot="{labels}"><div class="draft-grid"><fieldset v-for="slot in (['A','B'] as const)" :key="slot"><legend>Герои {{slot}}<template v-if="slot==='A'?teamALabel:teamBLabel"> · {{slot==='A'?teamALabel:teamBLabel}}</template><template v-else-if="slot==='A'?teamAId:teamBId"> · <ReportEntityLabel kind="teams" :id="(slot==='A'?teamAId:teamBId)??null" :name="labels['team:'+(slot==='A'?teamAId:teamBId)]" compact /></template></legend>
      <div v-for="p in (slot==='A'?lineupA:lineupB)" :key="p.rolePos" class="draft-player-row"><div class="draft-player"><strong>{{roleName(p.rolePos)}}</strong><ReportEntityLabel kind="players" :id="p.playerId" :name="labels['player:'+p.playerId]" compact /></div><div class="draft-pick"><label><span class="pick-label">{{slot}}: герой роли {{p.rolePos}}</span>
        <select :aria-label="`${slot}: герой роли ${p.rolePos}`" :value="picked(slot,p.rolePos)??''" @change="assign(slot,p.rolePos,$event)">
          <option value="">Не назначен</option><option v-if="picked(slot,p.rolePos)!==null&&!listed.has(picked(slot,p.rolePos)!)" :value="picked(slot,p.rolePos)">{{heroOptionLabel(picked(slot,p.rolePos)!,names.get(picked(slot,p.rolePos)!))}}</option>
          <option v-for="h in heroes.data.value?.items" :key="h.id" :value="h.id">{{heroOptionLabel(h.id,h.name)}}</option>
        </select>
      </label><div v-if="picked(slot,p.rolePos)!==null" v-show="!names.get(picked(slot,p.rolePos)!)?.trim()" class="hint player" :data-selected-hero="slot+':'+p.rolePos">Выбран: <ReportEntityLabel kind="heroes" :id="String(picked(slot,p.rolePos))" :name="names.get(picked(slot,p.rolePos)!)" compact /></div></div></div>
    </fieldset></div></DraftDisplayLabels>
    <details class="draft-help"><summary>Правила выбора героев</summary><p>Команды A/B обозначают выбранные составы. Каждый герой назначается один раз; герой из бана недоступен для пика. Можно сохранить от 0 до 10 героев. Список банов не задаёт хронологический порядок.</p></details>
    <fieldset class="ban-fieldset"><legend>Необязательные баны</legend><div class="ban-picker">
      <label>Команда бана<select v-model="banSide" aria-label="Команда бана"><option>A</option><option>B</option></select></label>
      <label>Герой для бана<select v-model="banHero" aria-label="Герой для бана"><option value="">Выберите героя</option><option v-if="banHero&&!listed.has(Number(banHero))" :value="banHero">{{heroOptionLabel(banHero,names.get(Number(banHero)))}}</option><option v-for="h in heroes.data.value?.items" :key="h.id" :value="h.id">{{heroOptionLabel(h.id,h.name)}}</option></select></label>
    <button type="button" @click="addBan">Добавить бан</button></div><p v-if="error" role="alert" class="error">{{error}}</p>
      <ul v-if="modelValue.bans.length"><li v-for="h in modelValue.bans" :key="h.heroId" :data-banned-hero="h.heroId">{{h.teamSlot}} · <ReportEntityLabel kind="heroes" :id="String(h.heroId)" :name="names.get(h.heroId)" /> <button type="button" :aria-label="`Удалить бан ${h.heroId}`" @click="emit('update:modelValue',{...modelValue,bans:modelValue.bans.filter(p=>p.heroId!==h.heroId)})">Удалить</button></li></ul>
    </fieldset>
  </fieldset>
</template>
<style scoped>
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:12px;margin-block:12px}#draftlab{margin:0}legend{color:var(--color-muted);font-weight:600}.draft-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
label{display:block;margin-block:6px}.draft-player-row{display:grid;grid-template-columns:minmax(100px,2fr) minmax(0,3fr);gap:10px;align-items:center;padding-block:6px;border-bottom:1px solid var(--color-border)}.draft-player-row:last-child{border-bottom:0}.draft-player{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:13px}.draft-player strong{font-size:12px;color:var(--color-muted)}.draft-pick{min-width:0}.draft-pick label{margin:0}.draft-pick select{width:100%;min-width:0;min-height:44px;padding:8px;font-size:14px}.pick-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.player{display:block;overflow-wrap:anywhere;font-size:12px;line-height:1.3;margin-top:4px}.draft-help{font-size:13px;margin-bottom:8px}.draft-help summary{cursor:pointer;min-height:28px}li{overflow-wrap:anywhere}li button{margin:8px}
.ban-picker{display:grid;grid-template-columns:100px minmax(0,1fr) auto;gap:12px;align-items:end}.ban-picker button{margin:0 0 6px}.ban-fieldset{margin-bottom:0}.draft-help{margin:4px 0}
@media(max-width:760px){.draft-grid{grid-template-columns:1fr}.ban-picker{grid-template-columns:1fr}.ban-picker button{width:100%}fieldset{padding:10px}.draft-player-row{grid-template-columns:minmax(90px,2fr) minmax(0,3fr)}}
</style>
