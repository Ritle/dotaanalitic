<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ScenarioInputSchema,ScenarioSnapshotSchema,ScenarioListSchema,ScenarioHistorySchema,DraftAssessmentSchema,V1ScheduleTargetSavedSchema,type ScenarioInput,type ScenarioSnapshot,type DraftInput,type DraftAssessment as Assessment} from '@dota/contracts';
import {LineupTemplateReportSchema} from '../../../api/src/modules/catalog/lineup-templates-contract';
import {confirmedMapLineups} from '../confirmed-map-lineups';
import ForecastLineups from '../components/ForecastLineups.vue';
import DraftEditor from '../components/DraftEditor.vue';
import DraftAssessment from '../components/DraftAssessment.vue';
import DraftCapture from '../components/DraftCapture.vue';
import {hasCompleteDraft} from '../draft-capture';
import HeroMatchups from '../components/HeroMatchups.vue';
import RoleSuggestions from '../components/RoleSuggestions.vue';
import RoleProfiles from '../components/RoleProfiles.vue';
import {moveRoleDraft,swapLineupRole,swapDraftRoles,lineupForRequest,preservePlayerCardOrder,type RoleMember} from '../role-suggestions';
import RoleSelect from '../components/RoleSelect.vue';
import ContextPicker from '../components/ContextPicker.vue';
import CatalogPicker from '../components/CatalogPicker.vue';
import ScenarioHistoryEntry from '../components/ScenarioHistoryEntry.vue';
import {readCatalog,dateLabel,CatalogRequestError} from '../catalog';
import {ownerAuth,accountAccess} from '../auth';
const route=useRoute(),router=useRouter(),cache=useQueryClient();
const id=computed(()=>String(route.params.id??'')),isNew=computed(()=>id.value==='new'),offset=ref(0),historyOffset=ref(0);
const five=()=>Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:null as string|null,isStandin:false}));
const blank=():ScenarioInput=>({title:'',teamAId:'',teamBId:'',cutoffAt:new Date().toISOString(),scheduledAt:null,
  lineupA:five(),lineupB:five(),expectedLineupA:null,expectedLineupB:null,confirmedByOwner:true,
  context:{seriesId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,firstPickSlot:null,venueKind:null,tournamentStage:null}});
const form=reactive(blank()),expectedA=ref(five()),expectedB=ref(five()),baselineA=ref(false),baselineB=ref(false),confirmed=ref(false);
// Display metadata is keyed by exact identity and stays outside immutable scenario input.
const labels=reactive<Record<string,string>>({});
const excludedPlayers=(current:{playerId:string|null})=>[...form.lineupA,...form.lineupB].filter(p=>p!==current&&p.playerId).map(p=>p.playerId!);
const excludedExpected=(current:{playerId:string|null})=>[...(baselineA.value?expectedA.value:[]),...(baselineB.value?expectedB.value:[])].filter(p=>p!==current&&p.playerId).map(p=>p.playerId!);
const manualRoles=reactive({A:false,B:false});
function changeRole(slot:'A'|'B',from:number,to:number){
 const rows=swapLineupRole(slot==='A'?form.lineupA:form.lineupB,from,to);if(!rows)return;
 manualRoles[slot]=true;draft.value=swapDraftRoles(draft.value,slot,from,to);
 if(slot==='A')form.lineupA=rows;else form.lineupB=rows;
}
const settingsOpen=ref(false);
function toggleSettings(event:Event){if(event.target===event.currentTarget&&event.target instanceof HTMLDetailsElement)settingsOpen.value=event.target.open;}
const draft=ref<DraftInput>({assignments:[],bans:[]}),preview=ref<Assessment|null>(null);let editGeneration=0;
const error=ref(''),busy=ref(false),conflict=ref(false),revision=ref<number|null>(null),loadedId=ref(''),saved=ref<ScenarioSnapshot|null>(null),dirty=ref(false);
const captureRequested=ref('');
const draftConflict=computed(()=>{const ids=[...draft.value.assignments,...draft.value.bans].map(h=>h.heroId);return new Set(ids).size!==ids.length;});
const draftSummary=computed(()=>draftConflict.value?'Есть повторяющиеся герои':draft.value.assignments.length===10?'Драфт заполнен: 10 разных героев':`Выбрано героев: ${draft.value.assignments.length} / 10`);
const currentAssessment=computed(()=>preview.value??(!dirty.value?saved.value?.draftAssessment:null));
const list=useQuery({queryKey:computed(()=>['scenarios',offset.value]),queryFn:({signal})=>readCatalog(`scenarios?offset=${offset.value}`,ScenarioListSchema,signal)});
const current=useQuery({queryKey:computed(()=>['scenario',id.value]),enabled:computed(()=>!!id.value&&!isNew.value),
  queryFn:({signal})=>readCatalog(`scenarios/${id.value}`,ScenarioSnapshotSchema,signal)});
const originTargetId=computed(()=>typeof route.query.scheduleTarget==='string'?route.query.scheduleTarget:'');
const originTarget=useQuery({queryKey:computed(()=>['schedule-target',originTargetId.value]),enabled:computed(()=>isNew.value&&!!originTargetId.value),
  queryFn:({signal})=>readCatalog(`schedule-targets/${encodeURIComponent(originTargetId.value)}`,V1ScheduleTargetSavedSchema,signal)});
const mapMode=computed(()=>!!originTargetId.value||(!isNew.value&&!!saved.value?.input.scheduledAt));
const initializedTarget=ref(''),importedTarget=ref(''),importedConfirmedAt=ref<number|null>(null);
const manualTemplateChoice=computed(()=>isNew.value&&!originTargetId.value&&!!form.teamAId&&!!form.teamBId&&
  !draft.value.assignments.length&&!manualRoles.A&&!manualRoles.B&&
  [form.lineupA,form.lineupB].every(rows=>rows.every((p,i)=>!p.playerId&&!p.isStandin&&p.rolePos===i+1)));
const templateQuery=(slot:'A'|'B')=>useQuery({
 queryKey:computed(()=>['owner-lineup-template',slot==='A'?form.teamAId:form.teamBId]),
 enabled:computed(()=>manualTemplateChoice.value||(isNew.value&&!!originTargetId.value&&importedTarget.value!==originTargetId.value&&!!(slot==='A'?form.teamAId:form.teamBId))),
 staleTime:0,
 queryFn:({signal,queryKey})=>readCatalog(`teams/${queryKey[1]}/lineup-template`,LineupTemplateReportSchema,signal)
});
const templateA=templateQuery('A'),templateB=templateQuery('B');
const mapReady=computed(()=>!mapMode.value||(!isNew.value?!!saved.value:importedTarget.value===originTargetId.value&&!!importedTarget.value&&importedConfirmedAt.value!==null&&importedConfirmedAt.value<=Date.parse(form.cutoffAt)));
const templateBusy=computed(()=>templateA.isFetching.value||templateB.isFetching.value);
const templateError=computed(()=>templateA.error.value?.message??templateB.error.value?.message);
const selectedTemplates=computed(()=>confirmedMapLineups(form.teamAId,form.teamBId,form.cutoffAt,templateA.data.value,templateB.data.value));
function fillManualLineups(){
 const lines=selectedTemplates.value;
 if(!manualTemplateChoice.value||!lines||templateBusy.value||templateError.value)return;
 manualRoles.A=true;manualRoles.B=true;
 Object.assign(form,lines);
}
watch([()=>templateA.data.value,()=>templateB.data.value,()=>form.teamAId,()=>form.teamBId,originTargetId,templateBusy,()=>form.cutoffAt],()=>{
 if(!isNew.value||!originTargetId.value||importedTarget.value===originTargetId.value||templateBusy.value||templateError.value)return;
 const lines=selectedTemplates.value;
 if(!lines)return;
 const wasDirty=dirty.value;Object.assign(form,lines);importedConfirmedAt.value=Math.max(Date.parse(templateA.data.value!.current!.confirmedAt),Date.parse(templateB.data.value!.current!.confirmedAt));importedTarget.value=originTargetId.value;dirty.value=wasDirty;
});
const history=useQuery({queryKey:computed(()=>['scenario-history',id.value,historyOffset.value]),enabled:computed(()=>!!id.value&&!isNew.value),
  queryFn:({signal})=>readCatalog(`scenarios/${id.value}/history?offset=${historyOffset.value}`,ScenarioHistorySchema,signal)});
const utc=(key:'cutoffAt'|'scheduledAt')=>computed({get:()=>form[key]?.replace(/Z$/,'')??'',set:(v:string)=>{
  const time=v?new Date(v+'Z').toISOString():null;if(key==='cutoffAt')form.cutoffAt=time??'';else form.scheduledAt=time;
}});
const cutoff=utc('cutoffAt'),scheduled=utc('scheduledAt');
watch([form,expectedA,expectedB,baselineA,baselineB,draft],()=>{confirmed.value=false;dirty.value=true;preview.value=null;editGeneration++;},{deep:true,flush:'sync'});
function hydrate(s:ScenarioSnapshot,orderA=form.lineupA,orderB=form.lineupB){
  const copy:ScenarioInput=JSON.parse(JSON.stringify(s.input));
  copy.lineupA=preservePlayerCardOrder(orderA,copy.lineupA);copy.lineupB=preservePlayerCardOrder(orderB,copy.lineupB);
  Object.assign(form,copy);expectedA.value=copy.expectedLineupA??five();expectedB.value=copy.expectedLineupB??five();
  draft.value=copy.draft??{assignments:[],bans:[]};
  baselineA.value=s.input.expectedLineupA!==null;baselineB.value=s.input.expectedLineupB!==null;revision.value=s.revision;saved.value=s;
  confirmed.value=false;dirty.value=false;loadedId.value=s.id;
}
watch(()=>current.data.value,s=>{if(s&&loadedId.value!==s.id)hydrate(s);},{immediate:true});
watch([id,originTargetId],()=>{settingsOpen.value=false;initializedTarget.value='';importedTarget.value='';importedConfirmedAt.value=null;error.value='';conflict.value=false;revision.value=null;loadedId.value='';saved.value=null;historyOffset.value=0;
  captureRequested.value='';
  manualRoles.A=false;manualRoles.B=false;
  Object.assign(form,blank());expectedA.value=five();expectedB.value=five();baselineA.value=false;baselineB.value=false;confirmed.value=false;dirty.value=false;
  draft.value={assignments:[],bans:[]};dirty.value=false;
  if(current.data.value)hydrate(current.data.value);
});
watch([()=>originTarget.data.value,isNew],([target,newScenario])=>{
  if(!newScenario||initializedTarget.value===originTargetId.value||dirty.value||!target||target.record.request.requestId!==originTargetId.value)return;
  const r=target.record,b=blank();
  Object.assign(form,{...b,title:(r.observation.match.name??'Первая карта встречи').slice(0,120),teamAId:r.request.teamAId,teamBId:r.request.teamBId,
    cutoffAt:r.observation.match.scheduledAt??b.cutoffAt,scheduledAt:r.observation.match.scheduledAt,
    context:{...b.context,leagueId:r.request.leagueId,mapNumber:1}});
  initializedTarget.value=originTargetId.value;confirmed.value=false;dirty.value=false;
},{immediate:true});
async function reload(){
  error.value='';const r=await current.refetch();if(r.data){hydrate(r.data);conflict.value=false;}else error.value='Не удалось загрузить редакцию.';
}
function applyRoles(slot:'A'|'B',rows:RoleMember[]){
  const before=slot==='A'?form.lineupA:form.lineupB;
  draft.value=moveRoleDraft(draft.value,slot,before,rows);
  if(slot==='A')form.lineupA=rows;else form.lineupB=rows;
}
function collect(requireConfirmation=true){
  if(mapMode.value&&!mapReady.value){error.value='Сначала подтвердите пятёрки и роли в подготовке встречи.';return null;}
  const raw=JSON.parse(JSON.stringify(form));raw.confirmedByOwner=mapMode.value?mapReady.value:(requireConfirmation?confirmed.value:true);raw.draft=JSON.parse(JSON.stringify(draft.value));
  const normalize=(rows:ReturnType<typeof five>)=>lineupForRequest(rows).map(p=>({...p,playerId:p.playerId||null}));
  raw.lineupA=normalize(form.lineupA);raw.lineupB=normalize(form.lineupB);
  raw.expectedLineupA=baselineA.value?normalize(expectedA.value):null;raw.expectedLineupB=baselineB.value?normalize(expectedB.value):null;
  for(const key of Object.keys(raw.context))if(raw.context[key]==='')raw.context[key]=null;
  const parsed=ScenarioInputSchema.safeParse(raw);
  if(!parsed.success){if(mapMode.value&&parsed.error.issues.some(issue=>['title','context','cutoffAt','scheduledAt'].includes(String(issue.path[0]))))settingsOpen.value=true;error.value='Проверьте название, две команды, 10 разных игроков, контекст и подтверждение. Герой может быть назначен или забанен только один раз.';return null;}
  return parsed.data;
}
async function checkDraft(){
  error.value='';const input=collect(false);if(!input)return;busy.value=true;const generation=editGeneration;
  try{const assessment=await readCatalog('scenarios/draft-check',DraftAssessmentSchema,new AbortController().signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(input)});
    if(editGeneration===generation)preview.value=assessment;
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось проверить доступность.';}finally{busy.value=false;}
}
async function save(){
  error.value='';conflict.value=false;const input=collect();if(!input)return;
  busy.value=true;const orderA=[...form.lineupA],orderB=[...form.lineupB];
  try{
    const s=await readCatalog(isNew.value?'scenarios':`scenarios/${id.value}`,ScenarioSnapshotSchema,new AbortController().signal,
      {method:isNew.value?'POST':'PUT',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},
        body:JSON.stringify(isNew.value?input:{expectedRevision:revision.value,input})});
    cache.setQueryData(['scenario',s.id],s);await cache.invalidateQueries({queryKey:['scenarios']});
    if(isNew.value)await router.replace({path:`/scenarios/${s.id}`,query:originTargetId.value?{scheduleTarget:originTargetId.value}:{}});
    hydrate(s,orderA,orderB);captureRequested.value=`${s.id}:${s.revision}`;await cache.invalidateQueries({queryKey:['scenario-history',s.id]});
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось сохранить сценарий.';conflict.value=e instanceof CatalogRequestError&&e.status===409;}
  finally{busy.value=false;}
}
</script>
<template>
  <main class="shell scenario-shell" :class="{'map-workspace':mapMode}">
    <nav class="scenario-topbar" aria-label="Навигация карты"><RouterLink to="/">← Справочники</RouterLink>
    <RouterLink v-if="originTargetId" :to="{path:`/schedule-targets/${originTargetId}`,query:saved?{scenario:saved.id}:{}}">← Вернуться к назначению карты</RouterLink></nav>
    <div class="scenario-title"><h1>{{mapMode?'Подготовка карты':'Сценарии'}}</h1><p v-if="mapMode" class="map-name">{{form.title}}</p></div>
    <p v-if="isNew&&originTargetId&&originTarget.isFetching.value" role="status">Загрузка назначения карты…</p>
    <p v-if="isNew&&originTargetId&&originTarget.error.value" role="alert" class="error">{{originTarget.error.value.message}}</p>
    <template v-if="isNew&&originTargetId">
      <p v-if="templateBusy" role="status">Загрузка подтверждённых пятёрок…</p>
      <div v-else-if="!mapReady" role="status" class="warning">
        <p>{{templateError??'Нет двух подтверждённых пятёрок с десятью разными игроками на выбранный срез.'}}</p>
        <RouterLink to="/upcoming">Подготовить составы встречи →</RouterLink>
        <button type="button" @click="templateA.refetch();templateB.refetch()">Повторить загрузку составов</button>
      </div>
    </template>
    <p v-if="!mapMode">Сохраните ручные составы и контекст карты. Подтверждение означает ваш выбор для сценария; фактическое участие игроков может измениться. Расчёт запускается отдельно.</p>
    <section v-if="!mapMode" class="panel" aria-label="Сохранённые сценарии">
      <div class="account-row"><h2>Мои сценарии</h2><RouterLink to="/scenarios/new">Создать сценарий →</RouterLink></div>
      <p v-if="list.isPending.value" role="status">Загрузка сценариев…</p><p v-else-if="list.error.value" class="error" role="alert">{{ list.error.value.message }}</p>
      <p v-else-if="!list.data.value?.items.length">Пока нет сохранённых сценариев.</p>
      <ul v-else class="scenario-list"><li v-for="s in list.data.value.items" :key="s.id"><RouterLink :to="`/scenarios/${s.id}`">{{s.input.title}}</RouterLink><span class="hint">Редакция {{s.revision}} · {{dateLabel(s.recordedAt)}}</span></li></ul>
      <div class="pagination"><button v-if="offset" @click="offset-=20">Предыдущие сценарии</button><button v-if="list.data.value?.hasMore" @click="offset+=20">Следующие сценарии</button></div>
    </section>
    <section v-if="id" class="panel" aria-label="Редактор сценария">
      <h2>{{isNew?'Новый сценарий':`Сценарий · редакция ${revision??'…'}`}}</h2>
      <RouterLink v-if="!isNew&&revision" :to="{path:`/scenarios/${id}/draft`,query:originTargetId?{scheduleTarget:originTargetId}:{},hash:'#draftlab'}">Открыть Draft Lab →</RouterLink>
      <p v-if="!isNew&&current.isPending.value" role="status">Загрузка редакции…</p><p v-else-if="!isNew&&current.error.value" role="alert" class="error">{{current.error.value.message}}</p>
      <form v-if="isNew||revision" @submit.prevent="save" :novalidate="mapMode">
        <fieldset :disabled="busy" class="scenario-fieldset">
          <component :is="mapMode?'details':'div'" class="scenario-settings" :open="mapMode?settingsOpen:undefined" @toggle="toggleSettings">
          <summary v-if="mapMode">Параметры карты и составы</summary>
          <ForecastLineups v-if="mapMode&&mapReady" :input="form" show-roles lazy label-prefix="Подтверждённый состав" />
          <p v-if="mapMode&&mapReady" class="hint">Состав выбран для этой карты. При замене игрока подготовьте новый сценарий из обновлённых составов встречи.</p>
          <label>Название<input v-model="form.title" maxlength="120" required /></label>
          <div class="scenario-grid">
            <CatalogPicker v-if="!mapMode" v-model="form.teamAId" kind="teams" label="Команда A: поиск по названию" :selected-label="labels['team:'+form.teamAId]" :excluded-ids="[form.teamBId]" @selected="item=>labels['team:'+item.id]=item.name" />
            <CatalogPicker v-if="!mapMode" v-model="form.teamBId" kind="teams" label="Команда B: поиск по названию" :selected-label="labels['team:'+form.teamBId]" :excluded-ids="[form.teamAId]" @selected="item=>labels['team:'+item.id]=item.name" />
            <label>Срез данных UTC<input v-model="cutoff" type="datetime-local" step="0.001" required /></label>
            <label>Плановое начало UTC · неизвестно, если пусто<input v-model="scheduled" :readonly="mapMode" type="datetime-local" step="0.001" /></label>
          </div>
          <template v-if="!mapMode"><p class="hint">Найдите команды и игроков по названию или нику и выберите запись из списка. Выберите роль в списке у игрока: если она занята, назначения ролей поменяются у двух игроков. Карточки остаются на месте; герой и отметка замены сохраняются за игроком. После правки подтвердите состав заново.</p>
          <template v-if="manualTemplateChoice">
            <p v-if="templateBusy" role="status">Загрузка подтверждённых пятёрок…</p>
            <p v-else-if="templateError" role="alert">{{templateError}} <button type="button" @click="templateA.refetch();templateB.refetch()">Повторить загрузку пятёрок</button></p>
            <div v-else-if="selectedTemplates">
              <p class="hint">Подтверждено владельцем: A — {{dateLabel(templateA.data.value?.current?.confirmedAt??null)}}, B — {{dateLabel(templateB.data.value?.current?.confirmedAt??null)}}.</p>
              <button type="button" @click="fillManualLineups">Подставить подтверждённые пятёрки</button>
            </div>
            <p v-else class="hint">Для этих команд на выбранный срез нет двух подтверждённых пятёрок с десятью разными игроками. Можно выбрать игроков вручную.</p>
          </template>
          <div class="scenario-grid">
            <fieldset v-for="slot in (['A','B'] as const)" :key="slot"><legend>Выбранный состав {{slot}}</legend>
              <div v-for="(p,index) in (slot==='A'?form.lineupA:form.lineupB)" :key="index" class="scenario-player" :data-player-card="`${slot}:${index+1}`">
                <CatalogPicker :model-value="p.playerId??''" @update:model-value="value=>p.playerId=value||null" kind="players" compact :label="`${slot}: игрок ${index+1}`" :selected-label="labels['player:'+p.playerId]" :excluded-ids="excludedPlayers(p)" @selected="item=>labels['player:'+item.id]=item.name" />
                <RoleSelect :model-value="p.rolePos" :label="`${slot}: роль игрока ${index+1}`" @update:model-value="role=>changeRole(slot,p.rolePos,role)" />
                <label class="check-row"><input v-model="p.isStandin" type="checkbox" />{{slot}}: замена игрока {{index+1}}</label>
              </div>
              <component :is="(slot==='A'?form.teamAId:form.teamBId)?RoleProfiles:RoleSuggestions" :key="id+':'+slot+':roles:'+(slot==='A'?form.teamAId:form.teamBId)"
                :team-id="slot==='A'?form.teamAId:form.teamBId" :preserve-manual="!isNew||manualRoles[slot]" :lineup="slot==='A'?form.lineupA:form.lineupB" :slot="slot" :cutoff-at="form.cutoffAt" :player-labels="labels" @apply="(rows:RoleMember[])=>applyRoles(slot,rows)" />
              <label class="check-row"><input v-if="slot==='A'" v-model="baselineA" type="checkbox" /><input v-else v-model="baselineB" type="checkbox" />Ожидаемый состав {{slot}}</label>
              <div v-if="slot==='A'?baselineA:baselineB"><p class="hint">Необязательная ручная база сравнения. Фиксированного штрафа за замену нет.</p>
                <CatalogPicker v-for="p in (slot==='A'?expectedA:expectedB)" :key="p.rolePos" :model-value="p.playerId??''" @update:model-value="value=>p.playerId=value||null" kind="players" :label="`${slot}: ожидаемый игрок роли ${p.rolePos}`" :selected-label="labels['player:'+p.playerId]" :excluded-ids="excludedExpected(p)" @selected="item=>labels['player:'+item.id]=item.name" />
              </div>
            </fieldset>
          </div>
          </template>
          <fieldset><legend>Контекст одной карты · пустое поле означает «неизвестно»</legend><div class="scenario-grid">
            <label>ID серии · если известен<input v-model="form.context.seriesId" /></label><ContextPicker :model-value="form.context.leagueId??''" @update:model-value="value=>form.context.leagueId=value||null" kind="leagues" label="Турнир карты" id-label="ID лиги · если известен" selection-label="Турнир" empty-label="Не указан" /><label>Номер карты<input v-model.number="form.context.mapNumber" type="number" min="1" max="5" /></label>
            <label>Победы A до карты<input v-model.number="form.context.teamASeriesWinsBefore" type="number" min="0" max="4" /></label>
            <label>Победы B до карты<input v-model.number="form.context.teamBSeriesWinsBefore" type="number" min="0" max="4" /></label>
            <label>Radiant<select v-model="form.context.radiantSlot"><option :value="null">Неизвестно</option><option>A</option><option>B</option></select></label>
            <label>Первый пик<select v-model="form.context.firstPickSlot"><option :value="null">Неизвестно</option><option>A</option><option>B</option></select></label>
            <label>Формат проведения<select v-model="form.context.venueKind"><option :value="null">Неизвестно</option><option value="lan">LAN</option><option value="online">Онлайн</option><option value="hybrid">Смешанный</option></select></label>
            <label>Стадия турнира<input v-model="form.context.tournamentStage" maxlength="120" /></label>
          </div></fieldset>
          </component>
          <div class="draft-workbench"><DraftEditor v-model="draft" :lineup-a="form.lineupA" :lineup-b="form.lineupB" :player-labels="labels" :team-a-id="mapMode?form.teamAId:undefined" :team-b-id="mapMode?form.teamBId:undefined" /></div>
          <aside class="map-controls" aria-label="Действия карты">
          <h3 v-if="mapMode">Состояние карты</h3>
          <p v-if="mapMode" role="status" :class="draftConflict?'error':'draft-count'">{{draftSummary}}</p>
          <p v-if="mapMode" class="hint">{{dirty?'Сохраните изменения перед расчётом.':saved?'Редакция '+saved.revision+' сохранена.':'Сохраните подготовленную карту.'}}</p>
          <button type="button" @click="checkDraft">Проверить доступность героев</button>

          <label v-if="!mapMode" class="check-row"><input v-model="confirmed" type="checkbox" required />Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы</label>
          <p v-if="!mapMode" class="hint">Время записи ставит сервер. Сохранение сегодня не доказывает доступность состава до исторического среза.</p>
          <p v-if="dirty" role="status">Есть несохранённые изменения.</p>
          <button type="submit" :disabled="!mapReady">{{busy?'Сохранение…':(mapMode?'Сохранить карту':'Сохранить сценарий')}}</button>
          <p v-if="error" role="alert" class="error">{{error}}</p><button v-if="conflict" type="button" :disabled="busy" @click="reload">Загрузить сохранённую редакцию · заменить мои правки</button>
          <DraftCapture v-if="saved&&hasCompleteDraft(saved)&&accountAccess?.role==='owner'" :key="saved.id+':'+saved.revision" :scenario="saved" :target-id="originTargetId" :requested="captureRequested===saved.id+':'+saved.revision" :dirty="dirty" @reload="reload" />
          <div v-if="mapMode" class="prediction-stage"><strong>Прогноз после драфта</strong><p class="hint">Модель ещё не доступна. Выбранные герои не меняют прогноз до драфта.</p></div>
          <p v-if="saved && !dirty"><RouterLink :to="originTargetId?{path:`/schedule-targets/${originTargetId}`,query:{scenario:saved.id}}:`/scenarios/${saved.id}/prediction`">Открыть расчёт одной карты</RouterLink></p>
      <p v-else-if="saved" class="hint">Сохраните изменения, чтобы перейти к расчёту карты.</p>
          <p v-if="mapMode&&saved&&!dirty" class="hint">Расчёт выше — для карты 1 до драфта.</p>
          <DraftAssessment v-if="currentAssessment" :assessment="currentAssessment" :saved="!preview" :compact="mapMode" />
          </aside>
        </fieldset>
      </form>

      <component :is="mapMode?'details':'div'" v-if="saved" class="scenario-audit"><summary v-if="mapMode">Сохранённая редакция и происхождение данных</summary>
      <div role="status" class="scenario-saved"><p>Сохранена редакция {{saved.revision}} · {{dateLabel(saved.recordedAt)}} · ручной ввод владельца.</p>
        <p v-if="saved.warnings.includes('RECORDED_AFTER_CUTOFF')" class="warning">Записано после среза. Этот состав не подтверждён как известный до карты.</p>
        <p>Срез: {{dateLabel(saved.input.cutoffAt)}}. Официальная доступность и пригодность для прогноза не проверены.</p>
      </div>

      <RouterLink v-if="saved" :to="`/scenarios/${saved.id}/report`">Открыть отчёты сценария</RouterLink>
      </component>

    </section>
    <component :is="mapMode?'details':'div'" v-if="saved&&!dirty" class="scenario-extra"><summary v-if="mapMode">Статистика пар героев</summary>
    <HeroMatchups :key="saved.id+':'+saved.revision" :scenario="saved" />
    </component>
    <component :is="mapMode?'details':'div'" v-if="id&&!isNew" class="scenario-extra"><summary v-if="mapMode">История карты</summary>
    <section v-if="id&&!isNew" class="panel" aria-label="История сценария"><h2>Сохранённые редакции</h2>
      <p v-if="history.isPending.value">Загрузка истории…</p><p v-if="history.error.value" class="error" role="alert">{{history.error.value.message}}</p>
      <ScenarioHistoryEntry v-for="s in history.data.value?.items" :key="id+':'+s.revision" :snapshot="s" />
      <div class="pagination"><button v-if="historyOffset" @click="historyOffset-=20">Новые редакции</button><button v-if="history.data.value?.hasMore" @click="historyOffset+=20">Ранние редакции</button></div>
    </section>
    </component>
  </main>
</template>
<style scoped>
.scenario-shell{max-width:none;padding:8px 0}.scenario-shell h1{font-size:28px}.scenario-topbar{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:14px}.scenario-title{display:flex;align-items:baseline;justify-content:space-between;gap:8px 24px;flex-wrap:wrap}.scenario-title h1,.scenario-title p{margin-block:10px}.scenario-shell>.eyebrow{display:none}.scenario-shell>p{margin-block:8px}.map-name{font-size:18px;color:var(--color-text)}.map-workspace .panel{margin-top:16px;padding:16px}.map-workspace .panel>h2{font-size:14px;color:var(--color-muted);margin-bottom:8px}.map-workspace .panel>a{display:inline-block;font-size:13px;margin-bottom:10px}
.map-workspace .scenario-fieldset{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}.map-workspace .draft-workbench{grid-column:1;grid-row:2;min-width:0}.map-workspace .map-controls{grid-column:2;grid-row:2;position:sticky;top:16px;border:1px solid var(--color-border);background:var(--color-elevated);border-radius:var(--radius-sm);padding:16px;min-width:0}.map-controls h3{margin:0}.map-controls button{width:100%;margin-top:8px}.map-controls .draft-count{color:var(--color-text);font-weight:600}.map-controls p{margin-block:8px}.prediction-stage{border-top:1px solid var(--color-border);margin-top:16px;padding-top:12px}.prediction-stage strong{font-size:14px}
.map-workspace .scenario-settings{grid-column:1/-1;grid-row:1;border-top:1px solid var(--color-border);padding-top:8px}.map-workspace .scenario-settings:not([open]){margin:0}.scenario-extra{margin-top:12px;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:8px 16px}.scenario-extra .panel{margin:8px 0}.scenario-audit{border-top:1px solid var(--color-border);padding-top:8px}
@media(max-width:1050px){.map-workspace .scenario-fieldset{grid-template-columns:1fr}.map-workspace .map-controls{grid-column:1;grid-row:3;position:static}.map-workspace .scenario-settings{grid-row:1}.scenario-shell{padding:0}}
.scenario-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin-block:var(--space-4)}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}
.scenario-fieldset{border:0;padding:0}legend{padding-inline:8px;color:var(--color-muted)}label{display:block}.check-row{display:flex;align-items:center;gap:8px;font-size:14px}.check-row input{width:20px;min-height:24px;flex-shrink:0}
.scenario-player{margin-block:var(--space-4);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-sm)}.scenario-list{padding-left:20px}.scenario-list li{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between}.scenario-saved{border-top:1px solid var(--color-border);margin-top:24px}.scenario-json{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
details{margin-block:12px}summary{cursor:pointer;min-height:44px;overflow-wrap:anywhere}@media(max-width:680px){.scenario-grid{grid-template-columns:1fr}.panel{padding:16px}.shell{padding-inline:14px}}
</style>
