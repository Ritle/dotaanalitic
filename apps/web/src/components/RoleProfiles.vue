<script setup lang="ts">
import {computed,reactive,ref,watch,nextTick} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {CatalogIdSchema,RoleProfilesReportSchema,RoleProfileBindingSavedSchema,RoleProfileBindingSchema,type RoleProfileBinding} from '@dota/contracts';
import {ownerAuth} from '../auth';
import {readCatalog,dateLabel} from '../catalog';
import {arrangeSuggestedRoles,roleName,type RoleMember} from '../role-suggestions';
import {roleEditorHints,roleSourceName} from '../role-editor';
const props=defineProps<{teamId:string;lineup:RoleMember[];slot:'A'|'B';cutoffAt?:string;preserveManual?:boolean;pandaTournamentId?:string;pandaTeamId?:string}>();
const emit=defineEmits<{apply:[lineup:RoleMember[]]}>(),cache=useQueryClient();
const ids=computed(()=>props.lineup.map(p=>p.playerId??'').filter(Boolean)),idsKey=computed(()=>[...ids.value].sort().join(':'));
const validTeam=computed(()=>CatalogIdSchema.safeParse(props.teamId).success);
const complete=computed(()=>validTeam.value&&ids.value.length===5&&new Set(ids.value).size===5&&ids.value.every(id=>CatalogIdSchema.safeParse(id).success));
const cutoff=computed(()=>props.cutoffAt&&props.cutoffAt<new Date().toISOString()?props.cutoffAt:undefined);
const automatic=ref(!props.preserveManual),busy=ref(false),error=ref(''),bindingConfirmed=ref(false),bindingRevision=ref<number|null>(null);
let internallyApplying=false,observedComplete=complete.value;
const layout=computed(()=>props.lineup.map(p=>`${p.rolePos}:${p.playerId??''}`).sort().join('|'));
watch(()=>props.preserveManual,v=>{if(v)automatic.value=false;});
watch(layout,()=>{
  if(internallyApplying)return;
  // Once five were chosen, subsequent slot/player edits are manual even before the first response arrives.
  if(observedComplete)automatic.value=false;
  if(complete.value)observedComplete=true;
},{flush:'sync'});
const headers=()=>({'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''});
const requestKey=computed(()=>['role-profiles',props.teamId,idsKey.value,cutoff.value??'now']);
async function load(signal:AbortSignal,refreshProfiles=false){return readCatalog('lineup-role-profiles',RoleProfilesReportSchema,signal,{method:'POST',headers:headers(),
  body:JSON.stringify({teamId:props.teamId,playerIds:ids.value,cutoffAt:cutoff.value,refreshProfiles})});}
const query=useQuery({queryKey:requestKey,enabled:complete,staleTime:60_000,queryFn:({signal})=>load(signal)});
const report=computed(()=>complete.value?query.data.value:undefined);
const editor=computed(()=>report.value?roleEditorHints(report.value.players):null);
const bindingQuery=useQuery({queryKey:computed(()=>['role-profile-binding',props.teamId]),enabled:validTeam,
  queryFn:({signal})=>readCatalog(`teams/${props.teamId}/role-profile-binding`,RoleProfileBindingSavedSchema,signal)});
const fields=reactive({stratzTeamId:'',pandaTournamentId:props.pandaTournamentId??'',pandaTeamId:props.pandaTeamId??'',players:{} as Record<string,string>});
function hydrate(binding:NonNullable<typeof bindingQuery.data.value>){
  fields.stratzTeamId=binding.binding.stratzTeamId??'';fields.pandaTournamentId=binding.binding.pandaTournamentId??props.pandaTournamentId??'';
  fields.pandaTeamId=binding.binding.pandaTeamId??props.pandaTeamId??'';
  fields.players=Object.fromEntries(binding.binding.pandaPlayers.map(p=>[p.playerId,p.providerPlayerId]));bindingRevision.value=binding.revision;bindingConfirmed.value=false;
}
watch(()=>bindingQuery.data.value,b=>{if(b&&bindingRevision.value===null)hydrate(b);},{immediate:true});
const options=computed(()=>report.value?.sources.find(s=>s.provider==='pandascore')?.observation?.players.filter(p=>p.providerTeamId===fields.pandaTeamId)??[]);
const selectedRoles=computed(()=>{
  if(!report.value||!editor.value?.canArrange)return null;
  return arrangeSuggestedRoles(props.lineup,{...report.value.history,players:report.value.history.players.map(p=>({...p,suggestedRole:editor.value!.players.find(r=>r.playerId===p.playerId)?.rolePos??null}))});
});
async function apply(auto=false){
  if(!selectedRoles.value||busy.value)return;
  internallyApplying=true;if(!auto)automatic.value=false;
  const rows=selectedRoles.value;observedComplete=true;
  emit('apply',rows);await nextTick();internallyApplying=false;
}
watch([editor,automatic,busy],()=>{if(automatic.value&&selectedRoles.value&&layout.value!==selectedRoles.value.map(p=>`${p.rolePos}:${p.playerId??''}`).sort().join('|'))void apply(true);});
async function refresh(){
  if(!complete.value||busy.value)return;error.value='';busy.value=true;
  const key=[...requestKey.value];
  try{const value=await load(new AbortController().signal,true);cache.setQueryData(key,value);}
  catch(e){error.value=e instanceof Error?e.message:'Не удалось обновить профили.';}finally{busy.value=false;}
}
let pending:{text:string;requestId:string}|null=null;
async function saveBinding(){
  error.value='';if(!bindingConfirmed.value||bindingRevision.value===null)return;
  const raw:RoleProfileBinding={stratzTeamId:fields.stratzTeamId||null,pandaTournamentId:fields.pandaTournamentId||null,pandaTeamId:fields.pandaTeamId||null,
    pandaPlayers:Object.entries(fields.players).filter(([,id])=>id).map(([playerId,providerPlayerId])=>({playerId,providerPlayerId}))};
  const parsed=RoleProfileBindingSchema.safeParse(raw);if(!parsed.success){error.value='Проверьте ID команд, турнира и разные записи игроков.';return;}
  const text=JSON.stringify({expectedRevision:bindingRevision.value,binding:parsed.data});if(pending?.text!==text)pending={text,requestId:crypto.randomUUID()};busy.value=true;
  try{
    const saved=await readCatalog(`teams/${props.teamId}/role-profile-binding`,RoleProfileBindingSavedSchema,new AbortController().signal,{method:'POST',headers:headers(),
      body:JSON.stringify({requestId:pending.requestId,expectedRevision:bindingRevision.value,binding:parsed.data,confirmedByOwner:true})});
    hydrate(saved);cache.setQueryData(['role-profile-binding',props.teamId],saved);await cache.invalidateQueries({queryKey:['role-profiles',props.teamId]});
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось сохранить сопоставление.';}finally{busy.value=false;}
}
const reason=(code:string)=>({IDENTITY_UNRESOLVED:'аккаунт не подтверждён однозначно',TEAM_BINDING_MISSING:'команда источника не сопоставлена',SOURCE_NOT_FRESH:'нет свежих данных источника',
  PLAYER_BINDING_MISSING:'игрок PandaScore не сопоставлен',PROFILE_MISSING_OR_DUPLICATE:'профиль отсутствует или неоднозначен',PROFILE_TEAM_MISMATCH:'в профиле другая команда',
  PROFILE_ROLE_UNKNOWN:'позиция профиля неизвестна',HISTORY_ROLE_UNKNOWN:'нет преобладающей позиции в истории',ROLE_SOURCES_CONFLICT:'источники расходятся',
  NO_ELIGIBLE_PRO_HISTORY:'нет pro-истории',ROLE_COVERAGE_PARTIAL:'неполное покрытие ролей',SMALL_SAMPLE:'мало карт',AMBIGUOUS_ROLE:'неоднозначная история',UNVALIDATED_HEURISTIC:'оценка по линии/GPM',
  disabled:'источник выключен',not_configured:'ключ не настроен',not_loaded:'данные ещё не загружены',cooldown:'ожидание перед новым запросом',refresh_in_progress:'обновляется',
  source_rate_limited:'лимит запросов источника',source_access_denied:'нет доступа к источнику',source_http_error:'ошибка источника',source_graphql_error:'ошибка ответа STRATZ',
  source_timeout:'источник не ответил вовремя',source_network_error:'не удалось связаться с источником',source_schema_invalid:'неизвестный формат ответа',
  invalid_cached_data:'сохранённые данные не прошли проверку',source_unavailable:'источник недоступен'}[code]??'требуется проверка');
</script>
<template>
  <section class="role-profiles" :aria-label="`Автоопределение ролей ${slot}`">
    <h3>Автоопределение ролей {{slot}}</h3>
    <label class="check-row"><input v-model="automatic" type="checkbox" />Автоподстановка ролей {{slot}}</label>
    <p class="hint">Приоритет: заявка PandaScore → профиль STRATZ → pro-история. Достаточно одной однозначной подсказки на игрока и пяти разных позиций. Герой и отметка замены остаются у игрока.</p>
    <p v-if="!automatic" class="hint" role="status">Ручная расстановка сохраняется. Для новой автоподстановки включите авто или нажмите «Применить роли». Сохранённые составы открываются с выключенным авто.</p>
    <p v-if="!complete">Для подсказки нужны пять разных игроков.</p>
    <p v-else-if="query.isFetching.value" role="status">Проверяем роли…</p>
    <template v-if="report">
      <p class="hint">Срез истории {{dateLabel(report.history.cutoffAt)}} · последние {{report.history.windowDays}} дней, до 20 карт. Кэш и история проверены {{dateLabel(report.snapshotAt)}}. Время получения профилей указано отдельно.</p>
      <p v-if="!report.configured.enabled">Профили API выключены настройкой ROLE_PROFILES_ENABLED. Доступны локальные подсказки.</p>
      <button type="button" :disabled="busy||!report.configured.enabled" @click="refresh">{{busy?'Обновление…':`Обновить профили API ${slot}`}}</button>
      <ul><li v-for="p in editor?.players??[]" :key="p.playerId">
        Игрок {{p.playerId}}: <strong :class="{warning:p.editorDuplicate}">{{p.rolePos===null?'Роль не определена':`${p.rolePos} · ${roleName(p.rolePos)}`}}</strong>
        <span v-if="p.editorSource" class="hint role-source">Определено автоматически · {{roleSourceName(p.editorSource)}}</span>
        <span class="hint"> · pro-карт с оценкой {{p.historyMaps}} · {{p.historyScope==='selected_team'?'в выбранной команде':'за все организации'}}</span>
        <p v-if="p.editorConflict" class="warning">Источники расходятся. Подсказка выбрана по приоритету; проверьте роль и при необходимости исправьте её вручную.</p>
        <p v-if="p.editorAmbiguous" class="warning">Доступные источники не задают однозначную позицию. Выберите роль вручную.</p>
        <p v-if="p.identityStatus!=='verified'" class="warning">Аккаунт не подтверждён однозначно. Автоматическая подсказка недоступна.</p>
        <p v-if="p.reasons.length" class="hint">{{p.reasons.filter(r=>r!=='ROLE_SOURCES_CONFLICT').map(reason).join('; ')}}</p>
        <details><summary>Основания игрока {{p.playerId}}</summary><p v-for="(c,i) in p.candidates" :key="i">{{c.source}}: {{c.roles.join('/')||'неизвестно'}} · {{c.eligible?'учтено':reason(c.reason??'')}}</p></details>
      </li></ul>
      <p v-if="editor?.hasDuplicates" role="status">Совпали позиции нескольких игроков. Расставьте их вручную.</p>
      <button type="button" :disabled="!selectedRoles||busy" @click="apply(false)">Применить роли {{slot}}</button>
      <details><summary>Время обновления источников {{slot}}</summary><p v-for="s in report.sources" :key="s.sourceKey">{{s.provider}} · ID {{s.sourceKey.split(':')[2]}} · {{s.status==='ready'?'актуально':s.status==='stale'?'устарело':'нет данных'}} · {{dateLabel(s.fetchedAt)}} · {{s.reason?reason(s.reason):'ответ сохранён'}}</p></details>
      <p class="hint">Профиль может устареть после трансфера. При расхождениях подсказка следует приоритету источников — проверьте спорные позиции. Точность ролей не измерена. V1 Elo от ролей не зависит.</p>
    </template>
    <details v-if="validTeam"><summary>Сопоставление источников {{slot}}</summary>
      <p class="hint">Сохраните соответствие команде один раз. Для PandaScore выберите каждого игрока явно: совпадение имени не подтверждает личность. Эти связи используются только для подсказок ролей.</p>
      <label>ID команды STRATZ {{slot}}<input v-model="fields.stratzTeamId" inputmode="numeric" @input="bindingConfirmed=false" /></label>
      <p v-for="s in report?.sources.filter(s=>s.provider==='stratz'&&s.observation?.players.length)??[]" :key="s.sourceKey" class="hint">{{s.observation?.players[0]?.name}} · команда источника {{s.observation?.players[0]?.providerTeamId??'неизвестна'}}</p>
      <label>ID турнира PandaScore {{slot}}<input v-model="fields.pandaTournamentId" inputmode="numeric" @input="bindingConfirmed=false" /></label>
      <label>ID команды PandaScore {{slot}}<input v-model="fields.pandaTeamId" inputmode="numeric" @input="bindingConfirmed=false" /></label>
      <label v-for="id in ids" :key="id">PandaScore для игрока {{slot}} {{id}}<select v-model="fields.players[id]" @change="bindingConfirmed=false"><option value="">Не сопоставлен</option>
        <option v-if="fields.players[id]&&!options.some(p=>p.providerPlayerId===fields.players[id])" :value="fields.players[id]">ID {{fields.players[id]}} · обновите заявку</option>
        <option v-for="p in options" :key="p.providerPlayerId" :value="p.providerPlayerId">{{p.name??'Без имени'}} · ID {{p.providerPlayerId}} · {{p.roles.join('/')||'роль неизвестна'}}</option>
      </select></label>
      <label class="check-row"><input v-model="bindingConfirmed" type="checkbox" />Подтверждаю соответствие команды и игроков источникам {{slot}}</label>
      <button type="button" :disabled="busy||!bindingConfirmed||bindingRevision===null" @click="saveBinding">Сохранить сопоставление {{slot}}</button>
      <button type="button" :disabled="busy" @click="async()=>{const r=await bindingQuery.refetch();if(r.data)hydrate(r.data);}">Перечитать сопоставление {{slot}}</button>
      <p class="hint">Редакция {{bindingRevision??'…'}}. Сначала сохраните ID турнира и команды, затем обновите профили API, чтобы получить список игроков.</p>
    </details>
    <p v-if="error||query.error.value||bindingQuery.error.value" role="alert" class="error">{{error||query.error.value?.message||bindingQuery.error.value?.message}}</p>
  </section>
</template>
<style scoped>
.role-profiles{margin-block:var(--space-4);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-sm);overflow-wrap:anywhere}h3{font-size:16px}label{display:block}
.role-source{display:block}.check-row{display:flex;align-items:center;gap:8px}.check-row input{width:20px;min-height:24px;flex-shrink:0}ul{padding-left:var(--space-4)}li{margin-block:var(--space-3)}summary{cursor:pointer;min-height:36px}
</style>
