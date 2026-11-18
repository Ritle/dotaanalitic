<script setup lang="ts">
import {roleSortedRows} from '../role-display';
import {computed,reactive,ref,watch,nextTick} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {CatalogIdSchema,RoleProfilesReportSchema,RoleProfileBindingSavedSchema,RoleProfileBindingSchema,type RoleProfileBinding} from '@dota/contracts';
import {ownerAuth} from '../auth';
import {readCatalog,dateLabel} from '../catalog';
import {arrangeSuggestedRoles,roleName,type RoleMember} from '../role-suggestions';
import {roleEditorHints,roleSourceName,rolePlayerLabel} from '../role-editor';
import {roleCandidateStatus,roleSourceStatus} from '../role-source-status';
import {matchingPlayerName,matchingSourceName} from '../source-matching-labels';
const props=defineProps<{teamId:string;lineup:RoleMember[];slot:'A'|'B';cutoffAt?:string;preserveManual?:boolean;disabled?:boolean;confirmationAction?:string;pandaTournamentId?:string;pandaTeamId?:string;playerLabels?:Record<string,string>}>();
const emit=defineEmits<{apply:[lineup:RoleMember[],automatic?:boolean]}>(),cache=useQueryClient();
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
const historyCoverage=computed(()=>report.value?.history.players.filter(p=>p.nRaw>0).length??0);
function playerLabel(player:NonNullable<typeof editor.value>['players'][number]){
 return report.value?rolePlayerLabel(report.value,player,props.playerLabels?.['player:'+player.playerId]):'Имя недоступно';}
const matchingName=(id:string)=>matchingPlayerName(id,props.playerLabels?.['player:'+id],report.value);
const matchingTeamName=computed(()=>props.playerLabels?.['team:'+props.teamId]?.trim()||`Выбранная команда ${props.slot}`);
function repeatedName(id:string){const name=matchingName(id);return !['Игрок без ника','Имя недоступно'].includes(name)&&ids.value.filter(other=>matchingName(other).toLowerCase()===name.toLowerCase()).length>1;}
function selectedRole(id:string){const role=props.lineup.find(p=>p.playerId===id)?.rolePos;return role?`${role} · ${roleName(role)}`:'Не указана';}
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
const alreadyApplied=computed(()=>!!selectedRoles.value&&selectedRoles.value.every(p=>props.lineup.find(old=>old.playerId===p.playerId)?.rolePos===p.rolePos));
async function apply(auto=false){
  if(!selectedRoles.value||busy.value||props.disabled||alreadyApplied.value)return;
  internallyApplying=true;if(!auto)automatic.value=false;
  const rows=selectedRoles.value;observedComplete=true;
  emit('apply',rows,auto);await nextTick();internallyApplying=false;
}
watch([editor,automatic,busy,()=>props.disabled],()=>{if(!props.disabled&&automatic.value&&selectedRoles.value&&layout.value!==selectedRoles.value.map(p=>`${p.rolePos}:${p.playerId??''}`).sort().join('|'))void apply(true);});
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
  PLAYER_BINDING_MISSING:'игрок PandaScore не сопоставлен',PROFILE_MISSING_OR_DUPLICATE:'профиль отсутствует или неоднозначен',PROFILE_TEAM_MISMATCH:'команда профиля неизвестна или не совпадает',
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
      <p class="hint">Локальная pro-история: {{historyCoverage}} / {{report.history.players.length}} игроков с подходящими картами за {{report.history.windowDays}} дней.</p>
      <p v-if="historyCoverage===0" class="warning">В текущей локальной выборке нет подходящих pro-карт игроков. Подсказки профилей API отображаются отдельно от истории карт.</p>
      <p v-if="!report.configured.enabled">Профили API выключены настройкой ROLE_PROFILES_ENABLED. Доступны локальные подсказки.</p>
      <button type="button" :disabled="busy||!report.configured.enabled" @click="refresh">{{busy?'Обновление…':`Обновить профили API ${slot}`}}</button>
      <p v-if="report.sources.some(s=>s.status!=='ready')" class="hint" role="status">Не все профили доступны для автоподстановки. Проверьте состояние источников ниже. Доступная pro-история и ручной выбор ролей сохраняются.</p>
      <ul><li v-for="p in roleSortedRows(editor?.players??[],p=>p.rolePos)" :key="p.playerId" :data-role-player-id="p.playerId">
        <span data-role-label>{{playerLabel(p)}}</span>: <strong :class="{warning:p.editorDuplicate}">{{p.rolePos===null?'Роль не определена':`${p.rolePos} · ${roleName(p.rolePos)}`}}</strong>
        <span v-if="p.editorSource" class="hint role-source">Определено автоматически · {{roleSourceName(p.editorSource)}}</span>
        <span class="hint"> · pro-карт с оценкой {{p.historyMaps}} · {{p.historyScope==='selected_team'?'в выбранной команде':'за все организации'}}</span>
        <p v-if="p.editorConflict" class="warning">Источники расходятся. Подсказка выбрана по приоритету; проверьте роль и при необходимости исправьте её вручную.</p>
        <p v-if="p.editorAmbiguous" class="warning">Доступные источники не задают однозначную позицию. Выберите роль вручную.</p>
        <p v-if="p.identityStatus!=='verified'" class="warning">Аккаунт не подтверждён однозначно. Автоматическая подсказка недоступна.</p>
        <details><summary>Основания игрока: {{matchingName(p.playerId)}}</summary>
          <p class="hint">Локальный ID игрока: {{p.playerId}}</p>
          <p class="hint">{{p.reasons.filter(r=>r!=='ROLE_SOURCES_CONFLICT'&&!p.candidates.some(c=>c.reason===r)).map(reason).join('; ')}}</p>
          <p v-for="(c,i) in p.candidates" :key="i">{{roleSourceName(c.source)}}: {{c.roles.join('/')||'неизвестно'}} · {{c.eligible?'учтено':roleCandidateStatus(report,p,c)??reason(c.reason??'')}}</p>
        </details>
      </li></ul>
      <p v-if="editor?.hasDuplicates" role="status">Совпали позиции нескольких игроков. Расставьте их вручную.</p>
      <p v-if="alreadyApplied" class="hint" role="status">Роли {{slot}} уже расставлены в форме.<template v-if="confirmationAction"> Для подтверждения состава проверьте пятёрку и нажмите «{{confirmationAction}}».</template></p>
      <button type="button" :disabled="!selectedRoles||busy||disabled||alreadyApplied" @click="apply(false)">Применить роли {{slot}}</button>
      <details><summary>Время обновления источников {{slot}}</summary><div v-for="s in report.sources" :key="s.sourceKey">
        <p>{{matchingSourceName(s,report,playerLabels)}} · {{s.status==='ready'?'ответ актуален':s.status==='stale'?'устарело':'нет данных'}} · {{dateLabel(s.fetchedAt)}}</p>
        <p class="hint">{{roleSourceStatus(s)}}<span v-if="s.reason"> Причина: {{reason(s.reason)}}.</span></p>
        <details><summary>Технический ключ источника</summary><p>{{s.sourceKey}}</p></details>
      </div></details>
      <p class="hint">Профиль может устареть после трансфера. При расхождениях подсказка следует приоритету источников — проверьте спорные позиции. Точность ролей не измерена. V1 Elo от ролей не зависит.</p>
    </template>
    <details v-if="validTeam" :data-source-matching="slot"><summary>Сопоставление источников {{slot}}</summary>
      <p>Локальная команда: <RouterLink :to="`/teams/${teamId}`" target="_blank" rel="noopener noreferrer">{{matchingTeamName}}</RouterLink></p>
      <details><summary>Данные выбранной команды</summary><p>Локальный ID команды: {{teamId}}</p></details>
      <p class="hint">Сохраните соответствие команде один раз. Для PandaScore выберите каждого игрока явно: совпадение имени не подтверждает личность. Эти связи используются только для подсказок ролей.</p>
      <details><summary>Идентификаторы источников {{slot}}</summary>
       <p class="hint">Здесь нужны внешние ID, не локальные ключи. Названия команды и турнира в этом ответе отсутствуют; имя локальной команды не подтверждает соответствие источнику.</p>
       <label>ID команды STRATZ {{slot}}<input v-model="fields.stratzTeamId" inputmode="numeric" @input="bindingConfirmed=false" /></label>
       <label>ID турнира PandaScore {{slot}}<input v-model="fields.pandaTournamentId" inputmode="numeric" @input="bindingConfirmed=false" /></label>
       <label>ID команды PandaScore {{slot}}<input v-model="fields.pandaTeamId" inputmode="numeric" @input="bindingConfirmed=false" /></label>
      </details>
      <div v-for="id in ids" :key="id" class="matching-player" :data-matching-player-id="id">
       <strong data-matching-name>{{matchingName(id)}}</strong><p class="hint">Выбранная роль: {{selectedRole(id)}}</p>
       <p v-if="repeatedName(id)" class="warning">Ник повторяется. Сверьте локальный ID и выбранную запись источника.</p>
       <details><summary>Данные выбранного игрока</summary><p>Локальный ID игрока: {{id}}</p><p class="hint">Имя — подпись выбранной записи, не доказательство соответствия аккаунту источника.</p></details>
       <label>Запись игрока PandaScore<select v-model="fields.players[id]" :aria-label="`PandaScore ${slot}: ${selectedRole(id)} · ${matchingName(id)}`" @change="bindingConfirmed=false"><option value="">Не сопоставлен</option>
        <option v-if="fields.players[id]&&!options.some(p=>p.providerPlayerId===fields.players[id])" :value="fields.players[id]">Запись PandaScore {{fields.players[id]}} · {{report?.sources.some(s=>s.provider==='pandascore'&&s.observation)?'нет в загруженной заявке':'заявка ещё не загружена'}}</option>
        <option v-for="p in options" :key="p.providerPlayerId" :value="p.providerPlayerId">{{p.name??'Без имени'}} · ID {{p.providerPlayerId}} · {{p.roles.join('/')||'роль неизвестна'}}</option>
       </select></label>
      </div>
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
.matching-player{margin-block:12px;padding:10px;border:1px solid var(--color-border);border-radius:var(--radius-sm);min-width:0}.matching-player select{width:100%;max-width:100%}.matching-player .hint{font-size:12px}
</style>
