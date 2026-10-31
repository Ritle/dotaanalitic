<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {CatalogListSchema,type DraftInput,type ScenarioInput} from '@dota/contracts';
import {readCatalog} from '../catalog';
const props=defineProps<{modelValue:DraftInput;lineupA:ScenarioInput['lineupA'];lineupB:ScenarioInput['lineupB']}>();
const emit=defineEmits<{'update:modelValue':[value:DraftInput]}>();
const search=ref(''),banHero=ref(''),banSide=ref<'A'|'B'>('A'),error=ref('');
const heroes=useQuery({queryKey:computed(()=>['catalog','heroes','draft',search.value]),
  queryFn:({signal})=>readCatalog(`heroes?limit=100&query=${encodeURIComponent(search.value)}`,CatalogListSchema,signal)});
const names=computed(()=>new Map(heroes.data.value?.items.map(h=>[Number(h.id),h.name])??[]));
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
  <fieldset id="draftlab"><legend>Draft Lab · герои по игрокам и ролям</legend>
    <p>Команды A/B обозначают выбранные составы. Каждый герой назначается один раз; герой из бана недоступен для пика. Можно сохранить от 0 до 10 героев. Список банов не задаёт хронологический порядок.</p>
    <label>Поиск героев в локальном каталоге<input v-model="search" type="search" maxlength="80" /></label>
    <p v-if="heroes.isPending.value" role="status">Загрузка героев…</p><p v-else-if="heroes.error.value" class="error" role="alert">{{heroes.error.value.message}} <button type="button" @click="heroes.refetch()">Повторить загрузку героев</button></p>
    <p v-else-if="!heroes.data.value?.items.length">Герои по запросу не найдены. Измените поиск или синхронизируйте каталог.</p>
    <p v-if="heroes.data.value?.hasMore" class="hint">Показаны первые100 героев. Уточните поиск по имени или ID.</p>
    <div class="draft-grid"><fieldset v-for="slot in (['A','B'] as const)" :key="slot"><legend>Герои {{slot}}</legend>
      <label v-for="p in (slot==='A'?lineupA:lineupB)" :key="p.rolePos">{{slot}}: герой роли {{p.rolePos}}<span class="hint player">Игрок {{p.playerId??'не указан'}}</span>
        <select :aria-label="`${slot}: герой роли ${p.rolePos}`" :value="picked(slot,p.rolePos)??''" @change="assign(slot,p.rolePos,$event)">
          <option value="">Не назначен</option><option v-if="picked(slot,p.rolePos)&&!names.has(picked(slot,p.rolePos)??0)" :value="picked(slot,p.rolePos)">Герой #{{picked(slot,p.rolePos)}}</option>
          <option v-for="h in heroes.data.value?.items" :key="h.id" :value="h.id">{{h.name}} · #{{h.id}}</option>
        </select>
        <span v-if="picked(slot,p.rolePos)!==null" class="hint player">Выбран: {{names.get(picked(slot,p.rolePos)??0)??'Герой'}} · #{{picked(slot,p.rolePos)}}</span>
      </label>
    </fieldset></div>
    <fieldset><legend>Необязательные баны</legend><div class="draft-grid">
      <label>Команда бана<select v-model="banSide" aria-label="Команда бана"><option>A</option><option>B</option></select></label>
      <label>Герой для бана<select v-model="banHero" aria-label="Герой для бана"><option value="">Выберите героя</option><option v-for="h in heroes.data.value?.items" :key="h.id" :value="h.id">{{h.name}} · #{{h.id}}</option></select></label>
    </div><button type="button" @click="addBan">Добавить бан</button><p v-if="error" role="alert" class="error">{{error}}</p>
      <ul><li v-for="h in modelValue.bans" :key="h.heroId">{{h.teamSlot}} · {{names.get(h.heroId)??`Герой #${h.heroId}`}} <button type="button" :aria-label="`Удалить бан ${h.heroId}`" @click="emit('update:modelValue',{...modelValue,bans:modelValue.bans.filter(p=>p.heroId!==h.heroId)})">Удалить</button></li></ul>
    </fieldset>
  </fieldset>
</template>
<style scoped>
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:16px;margin-block:16px}legend{color:var(--color-muted)}.draft-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:block;margin-block:12px}.player{display:block;overflow-wrap:anywhere;line-height:1.5}li{overflow-wrap:anywhere}li button{margin:8px}@media(max-width:680px){.draft-grid{grid-template-columns:1fr}}
</style>
