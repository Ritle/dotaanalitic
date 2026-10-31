<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ScenarioInputSchema,ScenarioSnapshotSchema,ScenarioListSchema,ScenarioHistorySchema,type ScenarioInput,type ScenarioSnapshot} from '@dota/contracts';
import {readCatalog,dateLabel,CatalogRequestError} from '../catalog';
import {ownerAuth} from '../auth';
const route=useRoute(),router=useRouter(),cache=useQueryClient();
const id=computed(()=>String(route.params.id??'')),isNew=computed(()=>id.value==='new'),offset=ref(0),historyOffset=ref(0);
const five=()=>Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:null as string|null,isStandin:false}));
const blank=():ScenarioInput=>({title:'',teamAId:'',teamBId:'',cutoffAt:new Date().toISOString(),scheduledAt:null,
  lineupA:five(),lineupB:five(),expectedLineupA:null,expectedLineupB:null,confirmedByOwner:true,
  context:{seriesId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,firstPickSlot:null,venueKind:null,tournamentStage:null}});
const form=reactive(blank()),expectedA=ref(five()),expectedB=ref(five()),baselineA=ref(false),baselineB=ref(false),confirmed=ref(false);
const error=ref(''),busy=ref(false),conflict=ref(false),revision=ref<number|null>(null),loadedId=ref(''),saved=ref<ScenarioSnapshot|null>(null),dirty=ref(false);
const list=useQuery({queryKey:computed(()=>['scenarios',offset.value]),queryFn:({signal})=>readCatalog(`scenarios?offset=${offset.value}`,ScenarioListSchema,signal)});
const current=useQuery({queryKey:computed(()=>['scenario',id.value]),enabled:computed(()=>!!id.value&&!isNew.value),
  queryFn:({signal})=>readCatalog(`scenarios/${id.value}`,ScenarioSnapshotSchema,signal)});
const history=useQuery({queryKey:computed(()=>['scenario-history',id.value,historyOffset.value]),enabled:computed(()=>!!id.value&&!isNew.value),
  queryFn:({signal})=>readCatalog(`scenarios/${id.value}/history?offset=${historyOffset.value}`,ScenarioHistorySchema,signal)});
const utc=(key:'cutoffAt'|'scheduledAt')=>computed({get:()=>form[key]?.replace(/Z$/,'')??'',set:(v:string)=>{
  const time=v?new Date(v+'Z').toISOString():null;if(key==='cutoffAt')form.cutoffAt=time??'';else form.scheduledAt=time;
}});
const cutoff=utc('cutoffAt'),scheduled=utc('scheduledAt');
watch([form,expectedA,expectedB,baselineA,baselineB],()=>{confirmed.value=false;dirty.value=true;},{deep:true,flush:'sync'});
function hydrate(s:ScenarioSnapshot){
  const copy:ScenarioInput=JSON.parse(JSON.stringify(s.input));
  Object.assign(form,copy);expectedA.value=copy.expectedLineupA??five();expectedB.value=copy.expectedLineupB??five();
  baselineA.value=s.input.expectedLineupA!==null;baselineB.value=s.input.expectedLineupB!==null;revision.value=s.revision;saved.value=s;
  confirmed.value=false;dirty.value=false;loadedId.value=s.id;
}
watch(()=>current.data.value,s=>{if(s&&loadedId.value!==s.id)hydrate(s);},{immediate:true});
watch(id,()=>{error.value='';conflict.value=false;revision.value=null;loadedId.value='';saved.value=null;historyOffset.value=0;
  Object.assign(form,blank());expectedA.value=five();expectedB.value=five();baselineA.value=false;baselineB.value=false;confirmed.value=false;dirty.value=false;
  if(current.data.value)hydrate(current.data.value);
});
async function reload(){
  error.value='';const r=await current.refetch();if(r.data){hydrate(r.data);conflict.value=false;}else error.value='Не удалось загрузить редакцию.';
}
async function save(){
  error.value='';conflict.value=false;
  const raw=JSON.parse(JSON.stringify(form));raw.confirmedByOwner=confirmed.value;
  const normalize=(rows:ReturnType<typeof five>)=>rows.map(p=>({...p,playerId:p.playerId||null}));
  raw.lineupA=normalize(form.lineupA);raw.lineupB=normalize(form.lineupB);
  raw.expectedLineupA=baselineA.value?normalize(expectedA.value):null;raw.expectedLineupB=baselineB.value?normalize(expectedB.value):null;
  for(const key of Object.keys(raw.context))if(raw.context[key]==='')raw.context[key]=null;
  const parsed=ScenarioInputSchema.safeParse(raw);
  if(!parsed.success){error.value='Укажите название, две разные команды, 10 разных игроков из каталога, корректный контекст карты и подтвердите составы.';return;}
  busy.value=true;
  try{
    const s=await readCatalog(isNew.value?'scenarios':`scenarios/${id.value}`,ScenarioSnapshotSchema,new AbortController().signal,
      {method:isNew.value?'POST':'PUT',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},
        body:JSON.stringify(isNew.value?parsed.data:{expectedRevision:revision.value,input:parsed.data})});
    cache.setQueryData(['scenario',s.id],s);await cache.invalidateQueries({queryKey:['scenarios']});
    if(isNew.value)await router.replace(`/scenarios/${s.id}`);
    hydrate(s);await cache.invalidateQueries({queryKey:['scenario-history',s.id]});
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось сохранить сценарий.';conflict.value=e instanceof CatalogRequestError&&e.status===409;}
  finally{busy.value=false;}
}
</script>
<template>
  <main class="shell">
    <RouterLink to="/">← Справочники</RouterLink><p class="eyebrow">DOTA 2 · ОДНА КАРТА</p><h1>Сценарии</h1>
    <p>Сохраните ручные составы и контекст карты. Подтверждение означает ваш выбор для сценария, а не официальную заявку турнира. Прогноз недоступен.</p>
    <section class="panel" aria-label="Сохранённые сценарии">
      <div class="account-row"><h2>Мои сценарии</h2><RouterLink to="/scenarios/new">Создать сценарий →</RouterLink></div>
      <p v-if="list.isPending.value" role="status">Загрузка сценариев…</p><p v-else-if="list.error.value" class="error" role="alert">{{ list.error.value.message }}</p>
      <p v-else-if="!list.data.value?.items.length">Пока нет сохранённых сценариев.</p>
      <ul v-else class="scenario-list"><li v-for="s in list.data.value.items" :key="s.id"><RouterLink :to="`/scenarios/${s.id}`">{{s.input.title}}</RouterLink><span class="hint">Редакция {{s.revision}} · {{dateLabel(s.recordedAt)}}</span></li></ul>
      <div class="pagination"><button v-if="offset" @click="offset-=20">Предыдущие сценарии</button><button v-if="list.data.value?.hasMore" @click="offset+=20">Следующие сценарии</button></div>
    </section>
    <section v-if="id" class="panel" aria-label="Редактор сценария">
      <h2>{{isNew?'Новый сценарий':`Сценарий · редакция ${revision??'…'}`}}</h2>
      <p v-if="!isNew&&current.isPending.value" role="status">Загрузка редакции…</p><p v-else-if="!isNew&&current.error.value" role="alert" class="error">{{current.error.value.message}}</p>
      <form v-if="isNew||revision" @submit.prevent="save">
        <fieldset :disabled="busy" class="scenario-fieldset">
          <label>Название<input v-model="form.title" maxlength="120" required /></label>
          <div class="scenario-grid">
            <label>Команда A: ID организации<input v-model="form.teamAId" inputmode="numeric" required /></label>
            <label>Команда B: ID организации<input v-model="form.teamBId" inputmode="numeric" required /></label>
            <label>Срез данных UTC<input v-model="cutoff" type="datetime-local" step="0.001" required /></label>
            <label>Плановое начало UTC · неизвестно, если пусто<input v-model="scheduled" type="datetime-local" step="0.001" /></label>
          </div>
          <div class="scenario-grid">
            <fieldset v-for="slot in (['A','B'] as const)" :key="slot"><legend>Выбранный состав {{slot}}</legend>
              <div v-for="p in (slot==='A'?form.lineupA:form.lineupB)" :key="p.rolePos" class="scenario-player">
                <label :for="`${slot}-${p.rolePos}`">{{slot}}: игрок роли {{p.rolePos}}</label><input :id="`${slot}-${p.rolePos}`" v-model="p.playerId" inputmode="numeric" required />
                <label class="check-row"><input v-model="p.isStandin" type="checkbox" />{{slot}}: замена роли {{p.rolePos}}</label>
              </div>
              <label class="check-row"><input v-if="slot==='A'" v-model="baselineA" type="checkbox" /><input v-else v-model="baselineB" type="checkbox" />Ожидаемый состав {{slot}}</label>
              <div v-if="slot==='A'?baselineA:baselineB"><p class="hint">Необязательная ручная база сравнения. Фиксированного штрафа за замену нет.</p>
                <label v-for="p in (slot==='A'?expectedA:expectedB)" :key="p.rolePos">{{slot}}: ожидаемый игрок роли {{p.rolePos}}<input v-model="p.playerId" inputmode="numeric" required /></label>
              </div>
            </fieldset>
          </div>
          <fieldset><legend>Контекст одной карты · пустое поле означает «неизвестно»</legend><div class="scenario-grid">
            <label>ID серии · если известен<input v-model="form.context.seriesId" /></label><label>Номер карты<input v-model.number="form.context.mapNumber" type="number" min="1" max="5" /></label>
            <label>Победы A до карты<input v-model.number="form.context.teamASeriesWinsBefore" type="number" min="0" max="4" /></label>
            <label>Победы B до карты<input v-model.number="form.context.teamBSeriesWinsBefore" type="number" min="0" max="4" /></label>
            <label>Radiant<select v-model="form.context.radiantSlot"><option :value="null">Неизвестно</option><option>A</option><option>B</option></select></label>
            <label>Первый пик<select v-model="form.context.firstPickSlot"><option :value="null">Неизвестно</option><option>A</option><option>B</option></select></label>
            <label>Формат проведения<select v-model="form.context.venueKind"><option :value="null">Неизвестно</option><option value="lan">LAN</option><option value="online">Онлайн</option><option value="hybrid">Смешанный</option></select></label>
            <label>Стадия турнира<input v-model="form.context.tournamentStage" maxlength="120" /></label>
          </div></fieldset>
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
    </section>
    <section v-if="id&&!isNew" class="panel" aria-label="История сценария"><h2>Сохранённые редакции</h2>
      <p v-if="history.isPending.value">Загрузка истории…</p><p v-if="history.error.value" class="error" role="alert">{{history.error.value.message}}</p>
      <details v-for="s in history.data.value?.items" :key="s.revision"><summary>Редакция {{s.revision}} · {{s.input.title}} · {{dateLabel(s.recordedAt)}}</summary>
        <p>Команды A / B: {{s.input.teamAId}} / {{s.input.teamBId}}. Срез: {{dateLabel(s.input.cutoffAt)}}. Radiant: {{s.input.context.radiantSlot??'неизвестно'}}; первый пик: {{s.input.context.firstPickSlot??'неизвестно'}}.</p>
        <div v-for="slot in (['A','B'] as const)" :key="slot"><h3>Состав {{slot}}</h3><p v-for="p in (slot==='A'?s.input.lineupA:s.input.lineupB)" :key="p.rolePos">Роль {{p.rolePos}} · {{p.playerId}}{{p.isStandin?' · замена':''}}</p></div>
        <p>Плановое начало: {{dateLabel(s.input.scheduledAt)}}. Серия: {{s.input.context.seriesId??'неизвестно'}}; карта: {{s.input.context.mapNumber??'неизвестно'}}; счёт до карты A / B: {{s.input.context.teamASeriesWinsBefore??'неизвестно'}} / {{s.input.context.teamBSeriesWinsBefore??'неизвестно'}}.</p>
        <p>Формат: {{s.input.context.venueKind==='lan'?'LAN':s.input.context.venueKind==='online'?'Онлайн':s.input.context.venueKind==='hybrid'?'Смешанный':'неизвестно'}}; стадия: {{s.input.context.tournamentStage??'неизвестно'}}.</p>
        <div v-for="slot in (['A','B'] as const)" :key="`expected-${slot}`"><h3>Ожидаемый состав {{slot}}</h3>
          <p v-if="!(slot==='A'?s.input.expectedLineupA:s.input.expectedLineupB)">Не задан</p>
          <p v-for="p in (slot==='A'?s.input.expectedLineupA:s.input.expectedLineupB)" :key="p.rolePos">Роль {{p.rolePos}} · {{p.playerId}}</p>
        </div>
      </details>
      <div class="pagination"><button v-if="historyOffset" @click="historyOffset-=20">Новые редакции</button><button v-if="history.data.value?.hasMore" @click="historyOffset+=20">Ранние редакции</button></div>
    </section>
  </main>
</template>
<style scoped>
.scenario-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin-block:var(--space-4)}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}
.scenario-fieldset{border:0;padding:0}legend{padding-inline:8px;color:var(--color-muted)}label{display:block}.check-row{display:flex;align-items:center;gap:8px;font-size:14px}.check-row input{width:20px;min-height:24px;flex-shrink:0}
.scenario-player{margin-block:var(--space-4)}.scenario-list{padding-left:20px}.scenario-list li{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between}.scenario-saved{border-top:1px solid var(--color-border);margin-top:24px}.scenario-json{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
details{margin-block:12px}summary{cursor:pointer;min-height:44px;overflow-wrap:anywhere}@media(max-width:680px){.scenario-grid{grid-template-columns:1fr}.panel{padding:16px}.shell{padding-inline:14px}}
</style>
