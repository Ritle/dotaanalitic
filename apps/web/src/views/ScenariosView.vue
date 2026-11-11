<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ScenarioInputSchema,ScenarioSnapshotSchema,ScenarioListSchema,ScenarioHistorySchema,DraftAssessmentSchema,V1ScheduleTargetSavedSchema,type ScenarioInput,type ScenarioSnapshot,type DraftInput,type DraftAssessment as Assessment} from '@dota/contracts';
import DraftEditor from '../components/DraftEditor.vue';
import DraftAssessment from '../components/DraftAssessment.vue';
import HeroMatchups from '../components/HeroMatchups.vue';
import RoleSuggestions from '../components/RoleSuggestions.vue';
import RoleProfiles from '../components/RoleProfiles.vue';
import {moveRoleDraft,swapLineupRole,swapDraftRoles,lineupForRequest,preservePlayerCardOrder,type RoleMember} from '../role-suggestions';
import RoleSelect from '../components/RoleSelect.vue';
import CatalogPicker from '../components/CatalogPicker.vue';
import ScenarioHistoryEntry from '../components/ScenarioHistoryEntry.vue';
import {readCatalog,dateLabel,CatalogRequestError} from '../catalog';
import {ownerAuth} from '../auth';
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
const draft=ref<DraftInput>({assignments:[],bans:[]}),preview=ref<Assessment|null>(null);let editGeneration=0;
const error=ref(''),busy=ref(false),conflict=ref(false),revision=ref<number|null>(null),loadedId=ref(''),saved=ref<ScenarioSnapshot|null>(null),dirty=ref(false);
const list=useQuery({queryKey:computed(()=>['scenarios',offset.value]),queryFn:({signal})=>readCatalog(`scenarios?offset=${offset.value}`,ScenarioListSchema,signal)});
const current=useQuery({queryKey:computed(()=>['scenario',id.value]),enabled:computed(()=>!!id.value&&!isNew.value),
  queryFn:({signal})=>readCatalog(`scenarios/${id.value}`,ScenarioSnapshotSchema,signal)});
const originTargetId=computed(()=>typeof route.query.scheduleTarget==='string'?route.query.scheduleTarget:'');
const originTarget=useQuery({queryKey:computed(()=>['schedule-target',originTargetId.value]),enabled:computed(()=>isNew.value&&!!originTargetId.value),
  queryFn:({signal})=>readCatalog(`schedule-targets/${encodeURIComponent(originTargetId.value)}`,V1ScheduleTargetSavedSchema,signal)});
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
watch(id,()=>{error.value='';conflict.value=false;revision.value=null;loadedId.value='';saved.value=null;historyOffset.value=0;
  manualRoles.A=false;manualRoles.B=false;
  Object.assign(form,blank());expectedA.value=five();expectedB.value=five();baselineA.value=false;baselineB.value=false;confirmed.value=false;dirty.value=false;
  draft.value={assignments:[],bans:[]};dirty.value=false;
  if(current.data.value)hydrate(current.data.value);
});
watch([()=>originTarget.data.value,isNew],([target,newScenario])=>{
  if(!newScenario||dirty.value||!target||target.record.request.requestId!==originTargetId.value)return;
  const r=target.record,b=blank();
  Object.assign(form,{...b,title:(r.observation.match.name??'Первая карта встречи').slice(0,120),teamAId:r.request.teamAId,teamBId:r.request.teamBId,
    cutoffAt:r.observation.match.scheduledAt??b.cutoffAt,scheduledAt:r.observation.match.scheduledAt,
    context:{...b.context,leagueId:r.request.leagueId,mapNumber:1}});
  confirmed.value=false;dirty.value=false;
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
  const raw=JSON.parse(JSON.stringify(form));raw.confirmedByOwner=requireConfirmation?confirmed.value:true;raw.draft=JSON.parse(JSON.stringify(draft.value));
  const normalize=(rows:ReturnType<typeof five>)=>lineupForRequest(rows).map(p=>({...p,playerId:p.playerId||null}));
  raw.lineupA=normalize(form.lineupA);raw.lineupB=normalize(form.lineupB);
  raw.expectedLineupA=baselineA.value?normalize(expectedA.value):null;raw.expectedLineupB=baselineB.value?normalize(expectedB.value):null;
  for(const key of Object.keys(raw.context))if(raw.context[key]==='')raw.context[key]=null;
  const parsed=ScenarioInputSchema.safeParse(raw);
  if(!parsed.success){error.value='Проверьте название, две команды, 10 разных игроков, контекст и подтверждение. Герой может быть назначен или забанен только один раз.';return null;}
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
    hydrate(s,orderA,orderB);await cache.invalidateQueries({queryKey:['scenario-history',s.id]});
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось сохранить сценарий.';conflict.value=e instanceof CatalogRequestError&&e.status===409;}
  finally{busy.value=false;}
}
</script>
<template>
  <main class="shell">
    <RouterLink to="/">← Справочники</RouterLink><p class="eyebrow">DOTA 2 · ОДНА КАРТА</p><h1>Сценарии</h1>
    <p v-if="originTargetId"><RouterLink :to="{path:`/schedule-targets/${originTargetId}`,query:saved?{scenario:saved.id}:{}}">← Вернуться к назначению карты</RouterLink></p>
    <p v-if="isNew&&originTargetId&&originTarget.isFetching.value" role="status">Загрузка назначения карты…</p>
    <p v-if="isNew&&originTargetId&&originTarget.error.value" role="alert" class="error">{{originTarget.error.value.message}}</p>
    <p v-if="isNew&&originTarget.data.value">Проверьте команды, турнир и время назначения. Выберите десять игроков вручную и подтвердите состав.</p>
    <p>Сохраните ручные составы и контекст карты. Подтверждение означает ваш выбор для сценария; фактическое участие игроков может измениться. Расчёт запускается отдельно.</p>
    <section class="panel" aria-label="Сохранённые сценарии">
      <div class="account-row"><h2>Мои сценарии</h2><RouterLink to="/scenarios/new">Создать сценарий →</RouterLink></div>
      <p v-if="list.isPending.value" role="status">Загрузка сценариев…</p><p v-else-if="list.error.value" class="error" role="alert">{{ list.error.value.message }}</p>
      <p v-else-if="!list.data.value?.items.length">Пока нет сохранённых сценариев.</p>
      <ul v-else class="scenario-list"><li v-for="s in list.data.value.items" :key="s.id"><RouterLink :to="`/scenarios/${s.id}`">{{s.input.title}}</RouterLink><span class="hint">Редакция {{s.revision}} · {{dateLabel(s.recordedAt)}}</span></li></ul>
      <div class="pagination"><button v-if="offset" @click="offset-=20">Предыдущие сценарии</button><button v-if="list.data.value?.hasMore" @click="offset+=20">Следующие сценарии</button></div>
    </section>
    <section v-if="id" class="panel" aria-label="Редактор сценария">
      <h2>{{isNew?'Новый сценарий':`Сценарий · редакция ${revision??'…'}`}}</h2>
      <RouterLink v-if="!isNew&&revision" :to="`/scenarios/${id}/draft#draftlab`">Открыть Draft Lab →</RouterLink>
      <p v-if="!isNew&&current.isPending.value" role="status">Загрузка редакции…</p><p v-else-if="!isNew&&current.error.value" role="alert" class="error">{{current.error.value.message}}</p>
      <form v-if="isNew||revision" @submit.prevent="save">
        <fieldset :disabled="busy" class="scenario-fieldset">
          <label>Название<input v-model="form.title" maxlength="120" required /></label>
          <div class="scenario-grid">
            <CatalogPicker v-model="form.teamAId" kind="teams" label="Команда A: поиск по названию" :selected-label="labels['team:'+form.teamAId]" :excluded-ids="[form.teamBId]" @selected="item=>labels['team:'+item.id]=item.name" />
            <CatalogPicker v-model="form.teamBId" kind="teams" label="Команда B: поиск по названию" :selected-label="labels['team:'+form.teamBId]" :excluded-ids="[form.teamAId]" @selected="item=>labels['team:'+item.id]=item.name" />
            <label>Срез данных UTC<input v-model="cutoff" type="datetime-local" step="0.001" required /></label>
            <label>Плановое начало UTC · неизвестно, если пусто<input v-model="scheduled" type="datetime-local" step="0.001" /></label>
          </div>
          <p class="hint">Найдите команды и игроков по названию или нику и выберите запись из списка. Выберите роль в списке у игрока: если она занята, назначения ролей поменяются у двух игроков. Карточки остаются на месте; герой и отметка замены сохраняются за игроком. После правки подтвердите состав заново.</p>
          <div class="scenario-grid">
            <fieldset v-for="slot in (['A','B'] as const)" :key="slot"><legend>Выбранный состав {{slot}}</legend>
              <div v-for="(p,index) in (slot==='A'?form.lineupA:form.lineupB)" :key="index" class="scenario-player" :data-player-card="`${slot}:${index+1}`">
                <CatalogPicker :model-value="p.playerId??''" @update:model-value="value=>p.playerId=value||null" kind="players" compact :label="`${slot}: игрок ${index+1}`" :selected-label="labels['player:'+p.playerId]" :excluded-ids="excludedPlayers(p)" @selected="item=>labels['player:'+item.id]=item.name" />
                <RoleSelect :model-value="p.rolePos" :label="`${slot}: роль игрока ${index+1}`" @update:model-value="role=>changeRole(slot,p.rolePos,role)" />
                <label class="check-row"><input v-model="p.isStandin" type="checkbox" />{{slot}}: замена игрока {{index+1}}</label>
              </div>
              <component :is="(slot==='A'?form.teamAId:form.teamBId)?RoleProfiles:RoleSuggestions" :key="id+':'+slot+':roles:'+(slot==='A'?form.teamAId:form.teamBId)"
                :team-id="slot==='A'?form.teamAId:form.teamBId" :preserve-manual="!isNew||manualRoles[slot]" :lineup="slot==='A'?form.lineupA:form.lineupB" :slot="slot" :cutoff-at="form.cutoffAt" :player-labels="(slot==='A'?form.teamAId:form.teamBId)?labels:undefined" @apply="(rows:RoleMember[])=>applyRoles(slot,rows)" />
              <label class="check-row"><input v-if="slot==='A'" v-model="baselineA" type="checkbox" /><input v-else v-model="baselineB" type="checkbox" />Ожидаемый состав {{slot}}</label>
              <div v-if="slot==='A'?baselineA:baselineB"><p class="hint">Необязательная ручная база сравнения. Фиксированного штрафа за замену нет.</p>
                <CatalogPicker v-for="p in (slot==='A'?expectedA:expectedB)" :key="p.rolePos" :model-value="p.playerId??''" @update:model-value="value=>p.playerId=value||null" kind="players" :label="`${slot}: ожидаемый игрок роли ${p.rolePos}`" :selected-label="labels['player:'+p.playerId]" :excluded-ids="excludedExpected(p)" @selected="item=>labels['player:'+item.id]=item.name" />
              </div>
            </fieldset>
          </div>
          <fieldset><legend>Контекст одной карты · пустое поле означает «неизвестно»</legend><div class="scenario-grid">
            <label>ID серии · если известен<input v-model="form.context.seriesId" /></label><label>ID лиги · если известен<input v-model="form.context.leagueId" inputmode="numeric" /></label><label>Номер карты<input v-model.number="form.context.mapNumber" type="number" min="1" max="5" /></label>
            <label>Победы A до карты<input v-model.number="form.context.teamASeriesWinsBefore" type="number" min="0" max="4" /></label>
            <label>Победы B до карты<input v-model.number="form.context.teamBSeriesWinsBefore" type="number" min="0" max="4" /></label>
            <label>Radiant<select v-model="form.context.radiantSlot"><option :value="null">Неизвестно</option><option>A</option><option>B</option></select></label>
            <label>Первый пик<select v-model="form.context.firstPickSlot"><option :value="null">Неизвестно</option><option>A</option><option>B</option></select></label>
            <label>Формат проведения<select v-model="form.context.venueKind"><option :value="null">Неизвестно</option><option value="lan">LAN</option><option value="online">Онлайн</option><option value="hybrid">Смешанный</option></select></label>
            <label>Стадия турнира<input v-model="form.context.tournamentStage" maxlength="120" /></label>
          </div></fieldset>
          <DraftEditor v-model="draft" :lineup-a="form.lineupA" :lineup-b="form.lineupB" />
          <button type="button" @click="checkDraft">Проверить доступность героев</button>
          <DraftAssessment v-if="preview" :assessment="preview" />
          <label class="check-row"><input v-model="confirmed" type="checkbox" required />Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы</label>
          <p class="hint">Время записи ставит сервер. Сохранение сегодня не доказывает доступность состава до исторического среза.</p>
          <p v-if="dirty" role="status">Есть несохранённые изменения.</p>
          <button type="submit">{{busy?'Сохранение…':'Сохранить сценарий'}}</button>
        </fieldset>
      </form>
      <p v-if="error" role="alert" class="error">{{error}}</p><button v-if="conflict" :disabled="busy" @click="reload">Загрузить сохранённую редакцию · заменить мои правки</button>
      <div v-if="saved" role="status" class="scenario-saved"><p>Сохранена редакция {{saved.revision}} · {{dateLabel(saved.recordedAt)}} · ручной ввод владельца.</p>
        <p v-if="saved.warnings.includes('RECORDED_AFTER_CUTOFF')" class="warning">Записано после среза. Этот состав не подтверждён как известный до карты.</p>
        <p>Срез: {{dateLabel(saved.input.cutoffAt)}}. Официальная доступность и пригодность для прогноза не проверены.</p>
      </div>
      <DraftAssessment v-if="saved?.draftAssessment" :assessment="saved.draftAssessment" saved />
      <RouterLink v-if="saved" :to="`/scenarios/${saved.id}/report`">Открыть отчёты сценария</RouterLink>
      <p v-if="saved && !dirty"><RouterLink :to="`/scenarios/${saved.id}/prediction`">Открыть расчёт одной карты</RouterLink></p>
      <p v-else-if="saved" class="hint">Сохраните изменения, чтобы перейти к расчёту выбранного состава.</p>
    </section>
    <HeroMatchups v-if="saved&&!dirty" :key="saved.id+':'+saved.revision" :scenario="saved" />
    <section v-if="id&&!isNew" class="panel" aria-label="История сценария"><h2>Сохранённые редакции</h2>
      <p v-if="history.isPending.value">Загрузка истории…</p><p v-if="history.error.value" class="error" role="alert">{{history.error.value.message}}</p>
      <ScenarioHistoryEntry v-for="s in history.data.value?.items" :key="id+':'+s.revision" :snapshot="s" />
      <div class="pagination"><button v-if="historyOffset" @click="historyOffset-=20">Новые редакции</button><button v-if="history.data.value?.hasMore" @click="historyOffset+=20">Ранние редакции</button></div>
    </section>
  </main>
</template>
<style scoped>
.scenario-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin-block:var(--space-4)}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}
.scenario-fieldset{border:0;padding:0}legend{padding-inline:8px;color:var(--color-muted)}label{display:block}.check-row{display:flex;align-items:center;gap:8px;font-size:14px}.check-row input{width:20px;min-height:24px;flex-shrink:0}
.scenario-player{margin-block:var(--space-4);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-sm)}.scenario-list{padding-left:20px}.scenario-list li{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between}.scenario-saved{border-top:1px solid var(--color-border);margin-top:24px}.scenario-json{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
details{margin-block:12px}summary{cursor:pointer;min-height:44px;overflow-wrap:anywhere}@media(max-width:680px){.scenario-grid{grid-template-columns:1fr}.panel{padding:16px}.shell{padding-inline:14px}}
</style>
