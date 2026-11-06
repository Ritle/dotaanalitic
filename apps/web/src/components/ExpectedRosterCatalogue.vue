<script setup lang="ts">
import {computed,reactive,ref,watch,onBeforeUnmount,nextTick} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {RosterCatalogueStateSchema,RosterCatalogueBindingSchema,RosterCataloguePreparedSchema,type RosterCataloguePrepared,type RosterCatalogueCandidate,type RosterCatalogueBinding} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import RosterCataloguePicker from './RosterCataloguePicker.vue';
import {preparedTeamView,preferredHistoryCandidate,type RosterPreparationNotice} from '../roster-preparation';
const props=defineProps<{matchId:string;rosterVersion?:string;automaticAllowed?:{A:boolean;B:boolean}}>(),emit=defineEmits<{apply:[slot:'A'|'B',binding:RosterCatalogueBinding,openEditor?:boolean];saved:[bindings:(RosterCatalogueBinding|null)[]];preparation:[notices:RosterPreparationNotice[]]}>();
const bridge=ref<HTMLElement|null>(null);
let disposed=false;onBeforeUnmount(()=>{disposed=true;});
const automaticAttempts=new Set<string>(),automaticSaves=new Set<string>();
const opened=ref(false),registrySha=ref(''),notice=ref('');
const prepared=ref<RosterCataloguePrepared|null>(null),preparing=ref(false);
const cache=useQueryClient();
type Draft={team:RosterCatalogueCandidate|null;accounts:Record<string,RosterCatalogueCandidate|null>;selected:Record<string,boolean>;confirmed:boolean;busy:boolean;error:string;pending:{text:string;id:string}|null};
const drafts=reactive<Record<string,Draft>>({});
const showConfirmed=reactive<Record<string,boolean>>({}),editedAccounts=reactive(new Set<string>());
const query=useQuery({queryKey:computed(()=>['roster-catalogue',props.matchId,props.rosterVersion??'']),
 queryFn:({signal})=>readCatalog(`upcoming/${props.matchId}/catalogue`,RosterCatalogueStateSchema,signal)});
watch(()=>query.data.value,data=>{for(const team of data?.teams??[]){if(drafts[team.providerTeamId]||!team.players.length)continue;
 const sourceTeam=team.binding?.usable?team.binding.source.team:undefined;
 drafts[team.providerTeamId]={team:sourceTeam?{id:sourceTeam.externalTeamId,name:team.binding!.teamName,provider:sourceTeam.provider,teamId:null,teamName:null}:null,accounts:Object.fromEntries(team.players.map(p=>{const saved=team.binding?.usable?team.binding.players.find(s=>s.providerPlayerId===p.providerPlayerId&&s.identityStatus==='verified'):undefined;
  return [p.providerPlayerId,saved?{id:saved.accountId,name:saved.name,localPlayerId:saved.playerId,teamId:null,teamName:null}:null];})),
  selected:Object.fromEntries(team.players.map(p=>[p.providerPlayerId,team.binding?.usable?team.binding.players.some(s=>s.providerPlayerId===p.providerPlayerId):team.players.length===5])),confirmed:false,busy:false,error:'',pending:null};
}if(data)emit('saved',data.teams.map(t=>t.binding?.usable?t.binding:null));},{immediate:true});
watch(()=>props.rosterVersion,()=>{for(const d of Object.values(drafts))d.confirmed=false;});
function observed(sha:string|null){if(!sha)return;if(registrySha.value&&registrySha.value!==sha){for(const d of Object.values(drafts))d.confirmed=false;notice.value='Каталог источника обновился. Проверьте выбранные аккаунты перед подтверждением.';}registrySha.value=sha;}
function preparedRow(team:string,player:string){return prepared.value?.teams.find(t=>t.providerTeamId===team)?.players.find(p=>p.providerPlayerId===player);}
const statusLabels={linked:'Связь сохранена',suggested:'Кандидат — проверьте аккаунт',ambiguous:'Несколько аккаунтов — выберите',not_found:'Аккаунт не найден',source_unavailable:'Поиск недоступен или отложен; повторите отдельно',conflict:'Конфликт сохранённых связей — требуется проверка'};
function rowStatus(team:string,player:string){const row=preparedRow(team,player),choice=drafts[team]?.accounts[player];
 return row?.status==='linked'&&choice&&choice.id!==row.candidates[0]?.id?'Выбран другой аккаунт — изменение ещё не сохранено':row?statusLabels[row.status]:'';}
function accountConfirmed(teamId:string,playerId:string){
 const team=query.data.value?.teams.find(t=>t.providerTeamId===teamId),choice=drafts[teamId]?.accounts[playerId];
 const saved=team?.binding?.usable?team.binding.players.find(p=>p.providerPlayerId===playerId&&p.identityStatus==='verified'):undefined;
 const row=prepared.value?.rosterSha256===query.data.value?.rosterSha256?preparedRow(teamId,playerId):undefined;
 const linked=row?.status==='linked'&&row.candidates.length===1&&row.linkToken===team?.players.find(p=>p.providerPlayerId===playerId)?.linkToken?row.candidates[0]:undefined;
 const accountId=saved?.accountId??linked?.id,localId=saved?.playerId??linked?.localPlayerId;
 return !!accountId&&(choice?choice.id===accountId&&(!choice.localPlayerId||choice.localPlayerId===localId):!editedAccounts.has(teamId+':'+playerId));
}
function confirmedCount(teamId:string){return query.data.value?.teams.find(t=>t.providerTeamId===teamId)?.players.filter(p=>accountConfirmed(teamId,p.providerPlayerId)).length??0;}
function chooseAccount(teamId:string,playerId:string,value:RosterCatalogueCandidate|null){const d=drafts[teamId];if(d){editedAccounts.add(teamId+':'+playerId);d.accounts[playerId]=value;d.confirmed=false;}}
async function preparePlayers(automatic=false){if(preparing.value)return;preparing.value=true;notice.value='';
 const sourceSha=query.data.value?.rosterSha256;
 try{const result=await cache.fetchQuery({queryKey:['roster-prepared',props.matchId,sourceSha,automatic?'cached':'full'],staleTime:automatic?60_000:0,
  queryFn:({signal})=>readCatalog(`upcoming/${props.matchId}/catalogue/prepare`,RosterCataloguePreparedSchema,signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(automatic?{externalSearch:false}:{})})});
  if(disposed)return;
  if(result.rosterSha256!==query.data.value?.rosterSha256){notice.value='Заявка изменилась. Перечитайте связи перед подготовкой.';return;}
  observed(result.registrySha256);prepared.value=structuredClone(result);
  for(const team of result.teams){const d=drafts[team.providerTeamId];if(!d)continue;d.confirmed=false;
   if(automatic&&opened.value){
    for(const p of team.players)if(p.status==='linked'&&p.candidates.length===1&&!d.accounts[p.providerPlayerId]&&!editedAccounts.has(team.providerTeamId+':'+p.providerPlayerId))d.accounts[p.providerPlayerId]=p.candidates[0]!;
    continue;
   }
   const sourceTeam=query.data.value?.teams.find(t=>t.providerTeamId===team.providerTeamId);
   if(!d.team&&sourceTeam?.name){const saved=sourceTeam.binding?.source.team;
    d.team=saved?{id:saved.externalTeamId,name:sourceTeam.binding!.teamName,provider:saved.provider,teamId:null,teamName:null}:
     {id:team.providerTeamId,name:sourceTeam.name,provider:'pandascore',teamId:null,teamName:null};}
   for(const p of team.players){const candidate=p.status==='ambiguous'?preferredHistoryCandidate(p.candidates):p.candidates[0];if(!d.accounts[p.providerPlayerId]&&!editedAccounts.has(team.providerTeamId+':'+p.providerPlayerId)&&candidate&&!candidate.discovery&&(p.status==='linked'||p.status==='suggested'||p.status==='ambiguous'))d.accounts[p.providerPlayerId]=candidate;}
  }
 }catch(e){notice.value=e instanceof Error?e.message:'Не удалось подготовить игроков.';}finally{preparing.value=false;}
}
function selection(id:string){const d=drafts[id]!;return (query.data.value?.teams.find(t=>t.providerTeamId===id)?.players??[]).filter(p=>d.selected[p.providerPlayerId]);}
function valid(id:string){const d=drafts[id]!,selected=selection(id),ids=selected.map(p=>d.accounts[p.providerPlayerId]?.id);
 return !!d.team&&d.confirmed&&(!!registrySha.value||selected.every(p=>{const a=d.accounts[p.providerPlayerId];return a?.localPlayerId||a?.profileSha256;}))&&!!query.data.value?.rosterSha256&&selected.length===5&&ids.every(Boolean)&&new Set(ids).size===5;}
async function save(id:string,index:number,openEditor=true,automatic=false){const d=drafts[id]!,state=query.data.value;if(!state||!valid(id))return;d.busy=true;d.error='';
 const raw={providerTeamId:id,teamId:d.team!.id,...(d.team!.provider==='pandascore'?{teamProvider:'pandascore'}:{}),expectedRevision:state.teams.find(t=>t.providerTeamId===id)?.binding?.revision??0,
  rosterSha256:state.rosterSha256,registrySha256:selection(id).some(p=>{const a=d.accounts[p.providerPlayerId];return a&&!a.localPlayerId&&!a.profileSha256;})?registrySha.value||null:null,players:selection(id).map(p=>{const account=d.accounts[p.providerPlayerId]!,linkToken=preparedRow(id,p.providerPlayerId)?.linkToken??p.linkToken;return {providerPlayerId:p.providerPlayerId,accountId:account.id,...(account.profileSha256?{profileSha256:account.profileSha256}:{}),...(account.localPlayerId?{localPlayerId:account.localPlayerId}:{}),...(linkToken?{linkToken}:{})};}),confirmedByOwner:true};
 const text=JSON.stringify(raw);if(d.pending?.text!==text)d.pending={text,id:crypto.randomUUID()};
 try{const binding=await readCatalog(`upcoming/${props.matchId}/catalogue/apply`,RosterCatalogueBindingSchema,new AbortController().signal,{method:'POST',
  headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({...raw,requestId:d.pending.id})});
  if(!disposed&&binding.usable&&(!automatic||props.automaticAllowed?.[index===0?'A':'B']&&!opened.value))emit('apply',index===0?'A':'B',binding,openEditor);else if(!binding.usable)d.error='Связи сохранены, но аккаунты требуют проверки. Пятёрка не подставлена.';
  const fresh=await query.refetch();
  for(const team of prepared.value?.teams??[])for(const player of team.players){const current=fresh.data?.teams.find(t=>t.providerTeamId===team.providerTeamId)?.players.find(p=>p.providerPlayerId===player.providerPlayerId);if(current?.linkToken)player.linkToken=current.linkToken;}
  await cache.invalidateQueries({queryKey:['upcoming-rosters']});d.confirmed=false;d.pending=null;
 }catch(e){d.error=e instanceof Error?e.message:'Не удалось сохранить связи.';}finally{d.busy=false;}
}
const notices=computed<RosterPreparationNotice[]>(()=>query.data.value?.teams.map((team,index)=>{
 const slot=index===0?'A':'B',d=drafts[team.providerTeamId],row=prepared.value?.rosterSha256===query.data.value?.rosterSha256?prepared.value?.teams.find(t=>t.providerTeamId===team.providerTeamId):null;
 const reserved=(query.data.value?.teams??[]).filter(t=>t.providerTeamId!==team.providerTeamId).flatMap(t=>{
  if(t.binding?.usable)return t.binding.players.map(p=>p.accountId);
  const other=drafts[t.providerTeamId];return other?Object.entries(other.selected).flatMap(([id,on])=>on&&other.accounts[id]?[other.accounts[id]!.id]:[]):[];
 });
 const view=row&&d?preparedTeamView(row,d.accounts,selection(team.providerTeamId).map(p=>p.providerPlayerId),reserved):null;
 return {slot,view,message:team.binding?.usable?'Сохранённая пятёрка доступна.':view?.message??(preparing.value?'Подготавливаем аккаунты игроков…':!team.players.length?'Заявка отсутствует. Обновите составы.':'Подготовка аккаунтов ещё не выполнена.'),busy:preparing.value||!!d?.busy,error:d?.error||notice.value};
})??(['A','B'] as const).map(slot=>({slot,view:null,message:query.error.value?'Не удалось прочитать сохранённые составы.':'Читаем составы и проверяем аккаунты…',busy:query.isFetching.value,error:query.error.value?.message??''})));
watch(notices,value=>emit('preparation',value),{immediate:true,deep:true});
watch([()=>query.data.value,()=>props.automaticAllowed,preparing],([state])=>{
 if(!state?.rosterSha256||preparing.value||!state.teams.some((t,i)=>!t.binding?.usable&&t.players.length&&props.automaticAllowed?.[i===0?'A':'B']))return;
 const key=state.rosterSha256;if(automaticAttempts.has(key))return;automaticAttempts.add(key);void preparePlayers(true);
},{immediate:true,deep:true});
watch(notices,rows=>{for(const n of rows){
 const team=query.data.value?.teams.find(t=>t.providerTeamId===n.view?.providerTeamId),d=team&&drafts[team.providerTeamId];
 if(disposed||opened.value||!n.view?.canAutoUse||n.busy||n.error||team?.binding?.usable||!d||!props.automaticAllowed?.[n.slot])continue;
 const key=JSON.stringify([props.matchId,query.data.value?.rosterSha256,n.slot,n.view.players.map(p=>[p.providerPlayerId,p.account?.id])]);
 if(automaticSaves.has(key))continue;automaticSaves.add(key);d.confirmed=true;void save(team.providerTeamId,n.slot==='A'?0:1,false,true);
}},{deep:true});
function togglePlayer(slot:'A'|'B',id:string,on:boolean){const team=query.data.value?.teams[slot==='A'?0:1],d=team&&drafts[team.providerTeamId];if(d&&!d.busy){d.selected[id]=on;d.confirmed=false;}}
async function usePrepared(slot:'A'|'B'){
 const n=notices.value.find(n=>n.slot===slot),team=query.data.value?.teams[slot==='A'?0:1],d=team&&drafts[team.providerTeamId];
 if(!n?.view?.canUse||n.busy||!team||!d)return;d.confirmed=true;await save(team.providerTeamId,slot==='A'?0:1,false);
}
async function openPreparation(){opened.value=true;await nextTick();bridge.value?.querySelector('button')?.focus();bridge.value?.scrollIntoView({block:'start'});}
defineExpose({togglePlayer,usePrepared,openPreparation});
</script>
<template>
 <section ref="bridge" class="catalogue-bridge" aria-label="Подготовка составов из заявки">
  <button type="button" @click="opened=!opened">{{opened?'Свернуть подготовку':'Подготовить составы'}}</button>
  <p v-if="query.isPending.value" role="status">Читаем сохранённые составы…</p>
  <p v-if="query.error.value" class="error" role="alert">{{query.error.value.message}} <button type="button" @click="query.refetch()">Повторить чтение составов</button></p>
  <template v-if="opened">
   <h3>Соединить заявку с историей игроков</h3>
   <p>Подготовьте игроков всей заявки. Сохранённые связи работают при смене ника и команды; новые совпадения нужно проверить.</p>
   <p v-if="query.isFetching.value" role="status">Читаем сохранённые связи…</p>
   <p v-if="notice" class="warning" role="status">{{notice}}</p>
   <button type="button" :disabled="query.isFetching.value" @click="query.refetch()">Перечитать связи</button>
   <button type="button" :disabled="preparing||query.isFetching.value||!query.data.value?.rosterSha256" @click="preparePlayers(false)">{{preparing?'Подготавливаем игроков…':'Подготовить игроков'}}</button>
   <p v-if="prepared" role="status">Подготовлено {{dateLabel(prepared.preparedAt)}}. Повторная подготовка сохраняет ваш выбор. Подсказки не подтверждают участие в матче.</p>
   <p class="hint">Совпадение ника — подсказка для поиска. Проверьте числовые ID. Команда в OpenDota может устареть после трансфера. При заявке больше пяти участников выберите нужных пятерых.</p>
   <div class="bridge-columns"><section v-for="(team,index) in query.data.value?.teams??[]" :key="team.providerTeamId" :aria-label="`Соединение ${index===0?'A':'B'}`">
    <h4>{{team.name}} · {{index===0?'A':'B'}}</h4>
    <template v-if="team.binding">
     <p>Сохранено {{dateLabel(team.binding.recordedAt)}} · редакция {{team.binding.revision}}</p>
     <p v-if="team.binding.source.team?.provider==='pandascore'" class="hint">Организация взята из заявки PandaScore. Персональная история считается по аккаунтам; общая история этой организации может ещё отсутствовать.</p>
     <details><summary>Сохранённая пятёрка {{index===0?'A':'B'}} · {{team.binding.players.length}} игроков</summary><ul><li v-for="p in team.binding.players" :key="p.providerPlayerId">{{p.name}} · аккаунт {{p.accountId}} · локальных pro-карт: {{p.proMaps}}<span v-if="p.proMaps===0"> — историю нужно загрузить</span></li></ul></details>
     <p v-if="!team.binding.usable" class="warning">Сохранённая пятёрка не соответствует текущей заявке или есть конфликт аккаунтов. Проверьте связи.</p>
     <button type="button" :disabled="!team.binding.usable" @click="emit('apply',index===0?'A':'B',team.binding)">Подставить сохранённую пятёрку {{index===0?'A':'B'}}</button>
    </template>
    <p v-if="!team.players.length">Заявка ещё не загружена. Нажмите «Обновить составы» выше.</p>
    <details v-else :open="!team.binding"><summary>Выбрать или исправить аккаунты {{index===0?'A':'B'}}</summary>
     <template v-if="drafts[team.providerTeamId]">
      <p class="hint">Подтверждено аккаунтов: {{confirmedCount(team.providerTeamId)}} / {{team.players.length}}. Требуют проверки: {{team.players.length-confirmedCount(team.providerTeamId)}}.</p>
      <label v-if="confirmedCount(team.providerTeamId)" class="check-row"><input v-model="showConfirmed[team.providerTeamId]" type="checkbox" />Показать подтверждённые аккаунты {{index===0?'A':'B'}}</label>
      <p v-if="confirmedCount(team.providerTeamId)===team.players.length&&!showConfirmed[team.providerTeamId]" role="status">Все аккаунты этой команды подтверждены. Раскройте их для ручного исправления.</p>
      <template v-if="drafts[team.providerTeamId]!.team?.provider==='pandascore'">
       <p role="status">Команда из заявки PandaScore: {{team.name}} · ID {{team.providerTeamId}}. Профиль организации OpenDota не требуется; аккаунты игроков проверяются отдельно.</p>
       <button type="button" @click="drafts[team.providerTeamId]!.team=null;drafts[team.providerTeamId]!.confirmed=false">Выбрать команду OpenDota {{index===0?'A':'B'}}</button>
      </template>
      <template v-else>
       <RosterCataloguePicker v-model="drafts[team.providerTeamId]!.team" :match-id="matchId" kind="teams" :label="`Команда OpenDota ${index===0?'A':'B'}`" :initial-query="team.name??''" @source="observed" @update:model-value="drafts[team.providerTeamId]!.confirmed=false" />
       <p class="hint">Если организация новая или её нет в OpenDota, используйте команду из заявки турнира.</p>
       <button type="button" @click="drafts[team.providerTeamId]!.team={id:team.providerTeamId,name:team.name??`PandaScore ${team.providerTeamId}`,provider:'pandascore',teamId:null,teamName:null};drafts[team.providerTeamId]!.confirmed=false">Использовать команду из заявки {{index===0?'A':'B'}}</button>
      </template>
      <div v-for="p in team.players" v-show="showConfirmed[team.providerTeamId]||!accountConfirmed(team.providerTeamId,p.providerPlayerId)" :key="p.providerPlayerId">
       <p v-if="preparedRow(team.providerTeamId,p.providerPlayerId)" role="status">{{p.name}}: {{rowStatus(team.providerTeamId,p.providerPlayerId)}}</p>
       <label class="check-row"><input v-model="drafts[team.providerTeamId]!.selected[p.providerPlayerId]" type="checkbox" @change="drafts[team.providerTeamId]!.confirmed=false" />{{p.name??`PandaScore ${p.providerPlayerId}`}} — включить в пятёрку</label>
       <RosterCataloguePicker v-if="drafts[team.providerTeamId]!.selected[p.providerPlayerId]" :model-value="drafts[team.providerTeamId]!.accounts[p.providerPlayerId]??null" :suggestions="preparedRow(team.providerTeamId,p.providerPlayerId)?.candidates" :match-id="matchId" kind="players" :label="`Аккаунт ${p.name??p.providerPlayerId} (${index===0?'A':'B'})`" :initial-query="p.name??''" @source="observed" @update:model-value="value=>chooseAccount(team.providerTeamId,p.providerPlayerId,value)" />
      </div>
      <p>Выбрано участников: {{selection(team.providerTeamId).length}} / 5.</p>
      <p>Выбрано аккаунтов: {{selection(team.providerTeamId).filter(p=>drafts[team.providerTeamId]!.accounts[p.providerPlayerId]).length}} / 5. Проверьте пять разных ID и подтвердите соответствие ниже.</p>
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
