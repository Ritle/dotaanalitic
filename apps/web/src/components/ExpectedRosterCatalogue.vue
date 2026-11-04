<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {RosterCatalogueStateSchema,RosterCatalogueBindingSchema,type RosterCatalogueCandidate,type RosterCatalogueBinding} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import RosterCataloguePicker from './RosterCataloguePicker.vue';
const props=defineProps<{matchId:string;rosterVersion?:string}>(),emit=defineEmits<{apply:[slot:'A'|'B',binding:RosterCatalogueBinding]}>();
const opened=ref(false),registrySha=ref(''),notice=ref('');
type Draft={team:RosterCatalogueCandidate|null;accounts:Record<string,RosterCatalogueCandidate|null>;selected:Record<string,boolean>;confirmed:boolean;busy:boolean;error:string;pending:{text:string;id:string}|null};
const drafts=reactive<Record<string,Draft>>({});
const query=useQuery({queryKey:computed(()=>['roster-catalogue',props.matchId,props.rosterVersion??'']),enabled:opened,
 queryFn:({signal})=>readCatalog(`upcoming/${props.matchId}/catalogue`,RosterCatalogueStateSchema,signal)});
watch(()=>query.data.value,data=>{for(const team of data?.teams??[]){if(drafts[team.providerTeamId]||!team.players.length)continue;
 drafts[team.providerTeamId]={team:null,accounts:Object.fromEntries(team.players.map(p=>[p.providerPlayerId,null])),
  selected:Object.fromEntries(team.players.map(p=>[p.providerPlayerId,team.players.length===5])),confirmed:false,busy:false,error:'',pending:null};
}},{immediate:true});
watch(()=>props.rosterVersion,()=>{for(const d of Object.values(drafts))d.confirmed=false;});
function observed(sha:string){if(registrySha.value&&registrySha.value!==sha){for(const d of Object.values(drafts)){d.team=null;d.accounts={};d.confirmed=false;}notice.value='Каталог источника обновился. Повторно выберите команду и аккаунты.';}registrySha.value=sha;}
function selection(id:string){const d=drafts[id]!;return (query.data.value?.teams.find(t=>t.providerTeamId===id)?.players??[]).filter(p=>d.selected[p.providerPlayerId]);}
function valid(id:string){const d=drafts[id]!,selected=selection(id),ids=selected.map(p=>d.accounts[p.providerPlayerId]?.id);
 return !!d.team&&d.confirmed&&!!registrySha.value&&!!query.data.value?.rosterSha256&&selected.length===5&&ids.every(Boolean)&&new Set(ids).size===5;}
async function save(id:string,index:number){const d=drafts[id]!,state=query.data.value;if(!state||!valid(id))return;d.busy=true;d.error='';
 const raw={providerTeamId:id,teamId:d.team!.id,expectedRevision:state.teams.find(t=>t.providerTeamId===id)?.binding?.revision??0,
  rosterSha256:state.rosterSha256,registrySha256:registrySha.value,players:selection(id).map(p=>({providerPlayerId:p.providerPlayerId,accountId:d.accounts[p.providerPlayerId]!.id})),confirmedByOwner:true};
 const text=JSON.stringify(raw);if(d.pending?.text!==text)d.pending={text,id:crypto.randomUUID()};
 try{const binding=await readCatalog(`upcoming/${props.matchId}/catalogue/apply`,RosterCatalogueBindingSchema,new AbortController().signal,{method:'POST',
  headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({...raw,requestId:d.pending.id})});
  if(binding.usable)emit('apply',index===0?'A':'B',binding);else d.error='Связи сохранены, но аккаунты требуют проверки. Пятёрка не подставлена.';
  await query.refetch();d.confirmed=false;d.pending=null;
 }catch(e){d.error=e instanceof Error?e.message:'Не удалось сохранить связи.';}finally{d.busy=false;}
}
</script>
<template>
 <section class="catalogue-bridge" aria-label="Подготовка составов из заявки">
  <h3>Соединить заявку с историей игроков</h3>
  <p>Один раз выберите аккаунты участников из OpenDota. Сохранённые связи можно использовать в следующих встречах.</p>
  <button type="button" @click="opened=!opened">{{opened?'Свернуть подготовку':'Подготовить составы'}}</button>
  <template v-if="opened">
   <p v-if="query.isFetching.value" role="status">Читаем сохранённые связи…</p>
   <p v-if="query.error.value" class="error" role="alert">{{query.error.value.message}}</p>
   <p v-if="notice" class="warning" role="status">{{notice}}</p>
   <button type="button" :disabled="query.isFetching.value" @click="query.refetch()">Перечитать связи</button>
   <p class="hint">Совпадение ника — подсказка для поиска. Проверьте числовые ID. Команда в OpenDota может устареть после трансфера. При заявке больше пяти участников выберите нужных пятерых.</p>
   <div class="bridge-columns"><section v-for="(team,index) in query.data.value?.teams??[]" :key="team.providerTeamId" :aria-label="`Соединение ${index===0?'A':'B'}`">
    <h4>{{team.name}} · {{index===0?'A':'B'}}</h4>
    <template v-if="team.binding">
     <p>Сохранено {{dateLabel(team.binding.recordedAt)}} · редакция {{team.binding.revision}}</p>
     <ul><li v-for="p in team.binding.players" :key="p.providerPlayerId">{{p.name}} · аккаунт {{p.accountId}} · локальных pro-карт: {{p.proMaps}}<span v-if="p.proMaps===0"> — историю нужно загрузить</span></li></ul>
     <p v-if="!team.binding.usable" class="warning">Сохранённая пятёрка не соответствует текущей заявке или есть конфликт аккаунтов. Проверьте связи.</p>
     <button type="button" :disabled="!team.binding.usable" @click="emit('apply',index===0?'A':'B',team.binding)">Подставить сохранённую пятёрку {{index===0?'A':'B'}}</button>
    </template>
    <p v-if="!team.players.length">Заявка ещё не загружена. Нажмите «Обновить составы» выше.</p>
    <details v-else :open="!team.binding"><summary>Выбрать или исправить аккаунты {{index===0?'A':'B'}}</summary>
     <template v-if="drafts[team.providerTeamId]">
      <RosterCataloguePicker v-model="drafts[team.providerTeamId]!.team" :match-id="matchId" kind="teams" :label="`Команда OpenDota ${index===0?'A':'B'}`" :initial-query="team.name??''" @source="observed" @update:model-value="drafts[team.providerTeamId]!.confirmed=false" />
      <div v-for="p in team.players" :key="p.providerPlayerId">
       <label class="check-row"><input v-model="drafts[team.providerTeamId]!.selected[p.providerPlayerId]" type="checkbox" @change="drafts[team.providerTeamId]!.confirmed=false" />{{p.name??`PandaScore ${p.providerPlayerId}`}} — включить в пятёрку</label>
       <RosterCataloguePicker v-if="drafts[team.providerTeamId]!.selected[p.providerPlayerId]" :model-value="drafts[team.providerTeamId]!.accounts[p.providerPlayerId]??null" :match-id="matchId" kind="players" :label="`Аккаунт ${p.name??p.providerPlayerId} (${index===0?'A':'B'})`" :initial-query="p.name??''" @source="observed" @update:model-value="value=>{drafts[team.providerTeamId]!.accounts[p.providerPlayerId]=value;drafts[team.providerTeamId]!.confirmed=false;}" />
      </div>
      <p>Выбрано участников: {{selection(team.providerTeamId).length}} / 5.</p>
      <label class="check-row"><input v-model="drafts[team.providerTeamId]!.confirmed" type="checkbox" />Подтверждаю соответствие команды и пяти аккаунтов {{index===0?'A':'B'}}</label>
      <button type="button" :disabled="drafts[team.providerTeamId]!.busy||!valid(team.providerTeamId)" @click="save(team.providerTeamId,index)">Сохранить связи и подставить пятёрку {{index===0?'A':'B'}}</button>
      <p v-if="drafts[team.providerTeamId]!.error" class="error" role="alert">{{drafts[team.providerTeamId]!.error}}</p>
     </template>
    </details>
   </section></div>
   <p class="hint">После подстановки проверьте роли ниже и подтвердите состав для одной карты. Подготовка аккаунтов не загружает автоматически историю карт и не запускает прогноз.</p>
  </template>
 </section>
</template>
<style scoped>
.catalogue-bridge{margin-block:var(--space-5);overflow-wrap:anywhere}.bridge-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}.bridge-columns>section{min-width:0;border:1px solid var(--color-border);padding:var(--space-3);border-radius:var(--radius-sm)}.check-row{display:flex;align-items:center;gap:8px}.check-row input{width:20px;min-height:24px;flex-shrink:0}summary{cursor:pointer;min-height:44px}button{white-space:normal;max-width:100%}@media(max-width:680px){.bridge-columns{grid-template-columns:1fr}}
</style>
