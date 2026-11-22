<script setup lang="ts">
import {computed,reactive,ref,watch,nextTick,onBeforeUnmount,shallowReactive} from 'vue';
import {useRouter} from 'vue-router';
import {useQueryClient} from '@tanstack/vue-query';
import {ScenarioInputSchema,ScenarioSnapshotSchema,type DraftInput,type UpcomingMatch} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth,accountAccess} from '../auth';
import CatalogPicker from './CatalogPicker.vue';
import OwnerLineupTemplate from './OwnerLineupTemplate.vue';
import UpcomingTeamSummary from './UpcomingTeamSummary.vue';
import UpcomingForecast from './UpcomingForecast.vue';
import LiveEstimate from './LiveEstimate.vue';
import DraftEditor from './DraftEditor.vue';
import UpcomingLineupCompare from './UpcomingLineupCompare.vue';
import RoleSuggestions from './RoleSuggestions.vue';
import RoleProfiles from './RoleProfiles.vue';
import RoleSelect from './RoleSelect.vue';
import {roleSortedRows} from '../role-display';
import {swapLineupRole,lineupForRequest,moveRoleDraft} from '../role-suggestions';
import {lineupReviewKey,draftReviewRoles,reviewedRoster,reviewedBindingLineup,type ReviewedRoster} from '../lineup-review';
import type {RoleMember} from '../role-suggestions';
import PlayerHistory from './PlayerHistory.vue';
import ExpectedRosterCatalogue from './ExpectedRosterCatalogue.vue';
import type {RosterCatalogueBinding} from '@dota/contracts';
import type {PreparedTeamView,RosterPreparationNotice} from '../roster-preparation';
import {upcomingParticipants,upcomingProviderForSlot,upcomingTeamLabel} from '../upcoming-participants';
const props=defineProps<{match:UpcomingMatch;rosterVersion?:string;live?:boolean;liveDraft?:boolean}>(),router=useRouter(),cache=useQueryClient();
const templates=shallowReactive<Partial<Record<'A'|'B',InstanceType<typeof OwnerLineupTemplate>>>>({});
const canManageLineups=computed(()=>accountAccess.value?.canManageLineups===true);
const manualOpen=ref(false);let disposed=false;onBeforeUnmount(()=>{disposed=true;});
const manualEditor=ref<HTMLDetailsElement|null>(null);
async function editLineups(){manualOpen.value=true;await nextTick();manualEditor.value?.querySelector('summary')?.focus();manualEditor.value?.scrollIntoView({block:'start'});}
const preparedLabels=reactive<Record<string,string>>({});
const catalogue=ref<InstanceType<typeof ExpectedRosterCatalogue>|null>(null),preparation=ref<RosterPreparationNotice[]>([]);
const automaticAllowed=computed(()=>Object.fromEntries((['A','B'] as const).map(slot=>[slot,canManageLineups.value&&!busy.value&&!confirmed.value&&!manualOpen.value&&!(slot==='A'?form.teamAId:form.teamBId)&&(slot==='A'?form.lineupA:form.lineupB).every(p=>!p.playerId)])) as {A:boolean;B:boolean});
function proposed(slot:'A'|'B'){return (slot==='A'?form.lineupA:form.lineupB).every(p=>!p.playerId)&&!(slot==='A'?form.teamAId:form.teamBId)?preparation.value.find(n=>n.slot===slot):undefined;}
function confirmedAccount(player:PreparedTeamView['players'][number]){
 const candidate=player.candidates.length===1?player.candidates[0]:undefined;
 return player.status==='linked'&&!!player.account?.localPlayerId&&player.account.id===candidate?.id&&player.account.localPlayerId===candidate?.localPlayerId;
}
const savedAt=reactive<Partial<Record<'A'|'B',string>>>({});
const hydratedSlots=new Set<'A'|'B'>();
const five=()=>Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:'',isStandin:false}));
const form=reactive({title:(props.match.name??'Сценарий встречи').slice(0,120),teamAId:'',teamBId:'',lineupA:five(),lineupB:five()});
const draft=ref<DraftInput>({assignments:[],bans:[]});
const mapNumber=ref<number|null>(null);
const mapNumbers=computed(()=>Array.from({length:Math.min(props.match.seriesBestOf??5,5)},(_,i)=>i+1));
const draftLineup=(rows:typeof form.lineupA)=>lineupForRequest(rows).map(p=>({...p,playerId:p.playerId||null}));
for(const slot of ['A','B'] as const){
 watch(()=>draftLineup(slot==='A'?form.lineupA:form.lineupB),(after,before)=>{
  if(!props.liveDraft||!draft.value.assignments.length)return;
  const players=new Set(before.map(p=>p.playerId));
  if(players.size===5&&!players.has(null)&&after.every(p=>players.has(p.playerId))&&new Set(after.map(p=>p.playerId)).size===5)
   draft.value=moveRoleDraft(draft.value,slot,before,after);
 });
}
const manualRoles=reactive({A:false,B:false});
function changeRole(slot:'A'|'B',from:number,to:number){const rows=swapLineupRole(slot==='A'?form.lineupA:form.lineupB,from,to);if(rows){manualRoles[slot]=true;if(slot==='A')form.lineupA=rows;else form.lineupB=rows;}}
const confirmed=ref(false),busy=ref(false),error=ref('');
const stages=reactive({A:{key:'',teamId:'',roles:{} as Record<string,number>,manual:false},B:{key:'',teamId:'',roles:{} as Record<string,number>,manual:false}});
let activeReview:Partial<Record<'A'|'B',ReviewedRoster>>|null=null;
function stageReview(slot:'A'|'B'){return reviewedRoster(proposed(slot)?.view,stages[slot].roles);}
watch(()=>[lineupReviewKey(proposed('A')?.view),lineupReviewKey(proposed('B')?.view)],keys=>{
 for(const [i,slot] of (['A','B'] as const).entries())if(stages[slot].key!==keys[i]){
  const state=stages[slot],view=proposed(slot)?.view,roles=draftReviewRoles(view);
  const samePlayers=state.teamId===view?.providerTeamId&&Object.keys(roles).length===5&&Object.keys(state.roles).length===5&&Object.keys(roles).every(id=>state.roles[id]!==undefined);
  state.key=keys[i]!;state.teamId=view?.providerTeamId??'';
  if(!samePlayers){state.roles=roles;state.manual=false;}
 }
},{immediate:true,flush:'sync'});
function reviewRows(slot:'A'|'B'){return roleSortedRows(proposed(slot)?.view?.players??[],p=>p.selected?stages[slot].roles[p.providerPlayerId]:null);}
function selectedRows(slot:'A'|'B'){return roleSortedRows((slot==='A'?form.lineupA:form.lineupB).map((p,index)=>({p,index})),row=>row.p.rolePos);}
function reviewIndex(slot:'A'|'B',id:string){return proposed(slot)?.view?.players.filter(p=>p.selected).findIndex(p=>p.providerPlayerId===id)??-1;}
function changeReviewRole(slot:'A'|'B',id:string,to:number){
 if(busy.value||!Number.isInteger(to)||to<1||to>5)return;
 const state=stages[slot],from=state.roles[id];if(from===undefined)return;
 const other=Object.keys(state.roles).find(key=>key!==id&&state.roles[key]===to);
 state.manual=true;state.roles[id]=to;if(other)state.roles[other]=from;confirmed.value=false;
}
function stageLineup(slot:'A'|'B'):RoleMember[]{return (proposed(slot)?.view?.players.filter(p=>p.selected)??[]).map(p=>({playerId:p.account?.localPlayerId??null,rolePos:stages[slot].roles[p.providerPlayerId]??1,isStandin:false}));}
function stageLabels(slot:'A'|'B'){return Object.fromEntries((proposed(slot)?.view?.players??[]).flatMap(p=>p.account?.localPlayerId?[[`player:${p.account.localPlayerId}`,p.account.name]]:[]));}
function applyStageRoles(slot:'A'|'B',rows:RoleMember[],automatic=false){
 if(!canManageLineups.value||busy.value||confirmed.value||automatic&&stages[slot].manual)return;
 // Explicit application is an owner choice; future automatic hints must preserve it.
 if(!automatic)stages[slot].manual=true;
 for(const p of proposed(slot)?.view?.players??[]){const role=rows.find(r=>r.playerId===p.account?.localPlayerId)?.rolePos;if(p.selected&&role)stages[slot].roles[p.providerPlayerId]=role;}
}
const hasPrepared=computed(()=>['A','B'].some(s=>!!proposed(s as 'A'|'B')?.view?.players.length));
const canConfirm=computed(()=>canManageLineups.value&&!busy.value&&(['A','B'] as const).every(slot=>!templates[slot]||templates[slot]!.ready)&&(hasPrepared.value?(['A','B'] as const).every(slot=>{
 const notice=proposed(slot);if(notice?.view?.players.length)return !!stageReview(slot)&&!!catalogue.value?.canUsePrepared(slot);
 const rows=slot==='A'?form.lineupA:form.lineupB;return !!(slot==='A'?form.teamAId:form.teamBId)&&rows.every(p=>p.playerId);
}):complete.value));
async function confirmLineups(){
 if(busy.value||confirmed.value)return;
 if(!canConfirm.value)return;error.value='';
 const captured:Partial<Record<'A'|'B',ReviewedRoster>>={};
 for(const slot of ['A','B'] as const){const review=stageReview(slot);if(review)captured[slot]=structuredClone(review);}
 busy.value=true;error.value='';const persisted:string[]=[];let current:'A'|'B'='A';activeReview=captured;
 try{
  for(const slot of ['A','B'] as const){current=slot;if(!captured[slot])continue;
   const binding=await catalogue.value?.usePrepared(slot);
   if(disposed)return;
   if(!binding||!reviewedBindingLineup(binding,captured[slot]!))throw new Error('Проверьте аккаунты и роли, при конфликте перечитайте связи.');
   persisted.push(slot);
  }
  if(!complete.value)throw new Error('Для общего подтверждения нужны две разные команды и десять разных игроков.');
  await nextTick();
  for(const slot of ['A','B'] as const){current=slot;const template=templates[slot];if(!template)throw Error('Дождитесь подготовки шаблона владельца.');
   await template.saveReviewed();if(disposed)return;
  }
  confirmed.value=true;
 }catch(e){if(!disposed)error.value=`${persisted.length?'Связи '+persisted.join(', ')+' сохранены; команда '+current+' требует проверки. ':''}Общее подтверждение не выполнено. ${e instanceof Error?e.message:'Перечитайте связи и повторите подтверждение.'}`;}
 finally{activeReview=null;busy.value=false;}
}

const participants=computed(()=>upcomingParticipants(props.match));
function useBinding(slot:'A'|'B',binding:RosterCatalogueBinding,openEditor=true){
 preparedLabels['team:'+binding.teamId]=binding.teamName;for(const p of binding.players)preparedLabels['player:'+p.playerId]=p.name;
 const review=activeReview?.[slot]??stageReview(slot),manual=stages[slot].manual;
 const lineup=review?reviewedBindingLineup(binding,review):binding.players.map((p,i)=>({rolePos:i+1,playerId:p.playerId,isStandin:false}));
 if(!lineup){error.value='Сохранённые аккаунты отличаются от проверяемого выбора. Перечитайте связи.';return;}
 if(manual)manualRoles[slot]=true;
 if(slot==='A'){form.teamAId=binding.teamId;form.lineupA=lineup;}else{form.teamBId=binding.teamId;form.lineupB=lineup;}
 savedAt[slot]=binding.recordedAt;confirmed.value=false;if(openEditor)manualOpen.value=true;
}
function applyTemplate(slot:'A'|'B',rows:RoleMember[]){if(busy.value||confirmed.value||manualRoles[slot])return;manualRoles[slot]=true;if(slot==='A')form.lineupA=rows.map(p=>({...p,playerId:p.playerId??''}));else form.lineupB=rows.map(p=>({...p,playerId:p.playerId??''}));}
function useSaved(bindings:(RosterCatalogueBinding|null)[]){
 // A roster refresh may arrive after the first empty catalogue. Fill each untouched side once.
 if(manualOpen.value||!participants.value.complete)return;
 for(const slot of ['A','B'] as const){
  if(hydratedSlots.has(slot)||(slot==='A'?form.teamAId:form.teamBId)||(slot==='A'?form.lineupA:form.lineupB).some(p=>p.playerId))continue;
  const binding=bindings.find(b=>b?.usable&&b.providerTeamId===upcomingProviderForSlot(props.match,slot));
  if(binding){useBinding(slot,binding,false);hydratedSlots.add(slot);}
 }
}
const complete=computed(()=>!!form.teamAId&&!!form.teamBId&&form.teamAId!==form.teamBId&&
 [...form.lineupA,...form.lineupB].every(p=>p.playerId)&&new Set([...form.lineupA,...form.lineupB].map(p=>p.playerId)).size===10);
watch(()=>[form.teamAId,form.teamBId,form.lineupA,form.lineupB],()=>{confirmed.value=false;},{deep:true,flush:'sync'});
// Exact saved owner assignments are already reviewed; opening a match performs no write.
watch(()=>[complete.value,templates.A?.confirmed,templates.B?.confirmed,busy.value],()=>{
 if(!busy.value)confirmed.value=complete.value&&templates.A?.confirmed===true&&templates.B?.confirmed===true;
},{flush:'post'});
const usedPlayers=(current:typeof form.lineupA[number])=>[...form.lineupA,...form.lineupB].filter(p=>p!==current&&p.playerId).map(p=>p.playerId);
const input=computed(()=>ScenarioInputSchema.safeParse({...form,lineupA:lineupForRequest(form.lineupA),lineupB:lineupForRequest(form.lineupB),cutoffAt:new Date().toISOString(),scheduledAt:props.live?null:props.match.scheduledAt,
  confirmedByOwner:confirmed.value,expectedLineupA:null,expectedLineupB:null,
  context:{seriesId:null,leagueId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,
    firstPickSlot:null,venueKind:null,tournamentStage:null}}));
const comparisonInput=computed(()=>{const q=input.value;return q.success?{
  teamAId:q.data.teamAId,teamBId:q.data.teamBId,lineupA:q.data.lineupA,lineupB:q.data.lineupB}:null;});
async function create(){
  error.value='';
  if(busy.value||!canManageLineups.value||props.live&&!props.liveDraft)return;
  if(!props.live&&props.match.scheduledAt&&props.match.scheduledAt<=new Date().toISOString()){
    error.value='Плановое начало уже наступило. Обновите расписание и уточните контекст карты.';return;
  }
  if(!input.value.success){error.value='Выберите две разные организации, десять разных игроков и подтвердите роли.';return;}
  let scenario={...input.value.data,cutoffAt:new Date().toISOString()};
  if(props.liveDraft){
    if(!confirmed.value||!complete.value)return;
    const teamNames=participants.value.complete?participants.value.label:[form.teamAId,form.teamBId].map(id=>preparedLabels['team:'+id]??('Команда #'+id)).join(' — ');
    const title=[teamNames,mapNumber.value?'Карта '+mapNumber.value:null].filter(Boolean).join(' · ').slice(0,120);
    const parsed=ScenarioInputSchema.safeParse({...scenario,title,draft:draft.value,context:{...scenario.context,mapNumber:mapNumber.value}});
    if(!parsed.success){error.value='Проверьте драфт: герой может быть выбран или забанен только один раз.';return;}
    scenario=parsed.data;
  }
  busy.value=true;
  try{
    const s=await readCatalog('scenarios',ScenarioSnapshotSchema,new AbortController().signal,{method:'POST',
      headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},
      body:JSON.stringify(scenario)});
    cache.setQueryData(['scenario',s.id],s);await cache.invalidateQueries({queryKey:['scenarios']});
    if(disposed)return;
    await router.push(props.liveDraft?{path:`/scenarios/${s.id}/draft`,query:{from:'live'}}:`/scenarios/${s.id}`);
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось создать сценарий.';}finally{busy.value=false;}
}
</script>
<template>
  <section v-if="liveDraft" aria-label="Драфт Live-карты" class="live-draft">
    <label>Номер карты <select v-model="mapNumber" :disabled="busy"><option :value="null">Не указан</option><option v-for="n in mapNumbers" :key="n" :value="n">Карта {{n}}</option></select></label>
    <DraftEditor v-model="draft" :lineup-a="draftLineup(form.lineupA)" :lineup-b="draftLineup(form.lineupB)" :player-labels="preparedLabels"
      :team-a-id="form.teamAId||undefined" :team-b-id="form.teamBId||undefined" :team-a-label="participants.complete&&match.opponents[0]?upcomingTeamLabel(match.opponents[0]):undefined" :team-b-label="participants.complete&&match.opponents[1]?upcomingTeamLabel(match.opponents[1]):undefined" :disabled="busy" />
    <template v-if="canManageLineups"><button type="button" :disabled="busy||!confirmed||!complete" @click="create">Сохранить карту</button>
      <p v-if="!confirmed" class="hint">Героев уже можно выбирать. Для сохранения проверьте обе пятёрки и роли ниже.</p>
      <p v-if="error" role="alert" class="error">{{error}}</p>
    </template>
    <p v-else class="hint">Сохранение карты доступно владельцу.</p>
  </section>
  <section aria-label="Составы для сравнения" class="comparison-start">
    <h3>{{liveDraft?'Составы карты':'Составы и прогноз'}}</h3>
    <p v-if="liveDraft" class="hint">Используйте сохранённые пятёрки или уточните участников этой карты.</p>
    <p v-else-if="live" class="hint">Проверьте пятёрки и получите условную оценку их силы без учёта текущей игры.</p>
    <p v-else class="hint">Проверьте составы и роли, затем получите прогноз первой карты или сравните историю игроков. Карта для прогноза подготовится автоматически.</p>
    <div class="manual-columns"><article v-for="slot in (['A','B'] as const)" :key="slot" :aria-label="`Выбранный состав ${slot}`">
      <h4>{{preparedLabels['team:'+(slot==='A'?form.teamAId:form.teamBId)]??(participants.complete?upcomingTeamLabel(match.opponents[slot==='A'?0:1]!):`Команда ${slot}`)}}</h4>
      <template v-if="proposed(slot)">
        <p role="status">{{proposed(slot)!.message}}</p>
        <ul><li v-for="p in reviewRows(slot)" :key="p.providerPlayerId" :data-review-role="p.selected?stages[slot].roles[p.providerPlayerId]:undefined">
          <label v-if="(proposed(slot)!.view?.players.length??0)>5" class="check-row"><input type="checkbox" :checked="p.selected" :disabled="!canManageLineups||busy||proposed(slot)!.busy" @change="catalogue?.togglePlayer(slot,p.providerPlayerId,($event.target as HTMLInputElement).checked)" />{{p.name??'Имя не указано'}} — в пятёрку {{slot}}</label>
          <span v-else>{{p.name??'Имя не указано'}}</span>
          <RoleSelect v-if="p.selected&&Object.keys(stages[slot].roles).length===5" :model-value="stages[slot].roles[p.providerPlayerId]!" :disabled="!canManageLineups||busy||proposed(slot)!.busy" :label="`${slot}: роль игрока ${reviewIndex(slot,p.providerPlayerId)+1}`" @update:model-value="r=>changeReviewRole(slot,p.providerPlayerId,r)" />
          <span v-if="p.account" class="account-note">{{p.account.name}} · Steam32 {{p.account.id}}</span>
          <span v-if="p.account?.proMaps!==undefined" class="account-note">Локальные pro-карты: {{p.account.proMaps}}</span>
          <span v-if="p.status==='ambiguous'&&p.account&&(p.account.proMaps??0)>0" class="account-note warning">Предложен по наличию pro-истории. Проверьте аккаунт; есть другие кандидаты.</span>
          <span v-else-if="confirmedAccount(p)" class="account-note">Связь аккаунта подтверждена ранее</span>
          <span v-else-if="p.status==='linked'&&p.account" class="account-note warning">Выбран другой аккаунт — требуется подтверждение</span>
          <span v-else-if="p.status==='suggested'&&p.account" class="account-note warning">Предложенный аккаунт — проверьте и подтвердите</span>
          <span v-else class="account-note warning">{{p.status==='ambiguous'?'Несколько аккаунтов — выберите нужный':p.status==='conflict'?'Конфликт аккаунтов':p.reason==='external_search_deferred'?'Нужен расширенный поиск аккаунта':p.status==='source_unavailable'?'Поиск временно недоступен':'Аккаунт требует уточнения'}}</span>
        </li></ul>
        <p v-if="proposed(slot)!.error" role="alert" class="error">{{proposed(slot)!.error}}</p>
        <p v-if="Object.keys(stages[slot].roles).length===5" class="hint">Проверьте ожидаемые роли. При отсутствии подсказок показан редактируемый черновик позиций, а не подтверждённые роли источника.</p>
        <RoleSuggestions v-if="stageLineup(slot).length===5&&stageLineup(slot).every(p=>p.playerId)" :lineup="stageLineup(slot)" :slot="slot" :player-labels="stageLabels(slot)" auto-apply :disabled="busy||!canManageLineups" confirmation-action="Подтвердить пятёрки и роли" :preserve-manual="busy||confirmed||stages[slot].manual" @apply="(rows,automatic)=>applyStageRoles(slot,rows,automatic)" />
        <button v-if="!proposed(slot)!.view?.canUse" type="button" :disabled="!canManageLineups||busy||proposed(slot)!.busy" @click="catalogue?.openPreparation()">Уточнить аккаунты {{slot}}</button>
      </template>
      <div v-else class="selected-player-cards"><div v-for="{p,index} in selectedRows(slot)" :key="index" class="selected-player-card" :data-review-role="p.rolePos" :data-player-card="`${slot}:${index+1}`">
        <strong>{{preparedLabels['player:'+p.playerId]??(p.playerId?`Игрок ${p.playerId}`:'Игрок не выбран')}}</strong><span v-if="p.isStandin"> · замена</span>
        <RoleSelect :model-value="p.rolePos" :disabled="!canManageLineups||busy" :label="`${slot}: роль игрока ${index+1}`" @update:model-value="role=>changeRole(slot,p.rolePos,role)" />
      </div></div>
      <p class="hint">Выбрано {{proposed(slot)?.view?.players.filter(p=>p.selected).length??(slot==='A'?form.lineupA:form.lineupB).filter(p=>p.playerId).length}} / 5<span v-if="savedAt[slot]"> · связи сохранены {{dateLabel(savedAt[slot]!)}}</span></p>
      <OwnerLineupTemplate v-if="(slot==='A'?form.teamAId:form.teamBId)&&(slot==='A'?form.lineupA:form.lineupB).every(p=>p.playerId)" :ref="el=>{templates[slot]=el?el as InstanceType<typeof OwnerLineupTemplate>:undefined}" :team-id="slot==='A'?form.teamAId:form.teamBId" :lineup="slot==='A'?form.lineupA:form.lineupB" :slot="slot" :preserve-manual="busy||confirmed||manualRoles[slot]" @apply="rows=>applyTemplate(slot,rows)" />
    </article></div>
    <p v-if="!complete" class="warning">Для сравнения нужны две пятёрки. Подготовленные игроки и причины незаполненных составов показаны в карточках выше.</p>
    <p class="hint">Сохранённые составы — ваш исходный выбор, участие в этой встрече не гарантировано. Укажите роль под именем игрока. Если роль занята, назначения поменяются у двух игроков. Обзор упорядочен по ролям: Carry → Mid → Offlane → SemiSupport → Hard Support. Заменить игрока можно ниже.</p>
    <button v-if="canManageLineups" type="button" :disabled="busy" @click="editLineups">Изменить игроков и роли</button>
    <button v-if="canManageLineups" type="button" :disabled="!canConfirm||confirmed" :aria-pressed="confirmed" @click="confirmLineups">{{busy?'Подтверждаем…':'Подтвердить пятёрки и роли'}}</button>
    <p v-if="confirmed" role="status">Используются сохранённые пятёрки и роли. Повторное подтверждение не требуется.</p>
    <p v-if="error&&!liveDraft" role="alert" class="error">{{error}}</p>
    <component :is="live?LiveEstimate:UpcomingForecast" v-if="participants.complete&&!liveDraft" :key="match.providerMatchId" :match="match" :input="input.success?input.data:null" :confirmed="confirmed" :disabled="busy" @busy="busy=$event" />
    <UpcomingLineupCompare v-if="!liveDraft" :input="busy?null:comparisonInput" :player-labels="preparedLabels" />
  </section>
  <fieldset class="catalogue-lock" :disabled="busy||!canManageLineups"><ExpectedRosterCatalogue v-if="participants.complete" ref="catalogue" :match-id="match.providerMatchId" :roster-version="rosterVersion" :automatic-allowed="automaticAllowed" @apply="useBinding" @saved="useSaved" @preparation="preparation=$event" /></fieldset>
  <details v-if="canManageLineups" ref="manualEditor" class="manual-scenario" :open="manualOpen" @toggle="manualOpen=($event.target as HTMLDetailsElement).open"><summary>Выбрать игроков для анализа одной карты</summary>
    <p>Задайте игроков и их роли по локальному справочнику. Заявка турнира служит ориентиром; состав сценария подтверждаете вы.</p>
    <p class="hint">Выбор занятой роли меняет назначения ролей у двух игроков, сохраняя порядок карточек. В пятёрке всегда по одной роли 1–5; после изменения подтвердите состав заново.</p>
    <p class="hint">Найдите запись по имени или ID и выберите её из списка. Если записи нет в локальной базе, состав остаётся неполным.</p>
    <p v-if="!participants.complete" class="warning">Это гипотетический сценарий с выбранными вами командами. Он не подтверждает участников этой встречи и не привязывает к ней реальный прогноз.</p>
    <form @submit.prevent="!live && create()"><fieldset :disabled="busy" class="scenario-fields">
      <label>Название сценария<input v-model="form.title" maxlength="120" required /></label>
      <div class="manual-columns"><fieldset v-for="slot in (['A','B'] as const)" :key="slot">
        <legend>Команда {{slot}} · {{participants.complete?upcomingTeamLabel(match.opponents[slot==='A'?0:1]!):'выберите вручную'}}</legend>
        <CatalogPicker v-if="slot==='A'" v-model="form.teamAId" kind="teams" label="Команда A в локальной базе" :selected-label="preparedLabels['team:'+form.teamAId]" :excluded-ids="[form.teamBId]" @selected="p=>preparedLabels['team:'+p.id]=p.name??p.id" />
        <CatalogPicker v-else v-model="form.teamBId" kind="teams" label="Команда B в локальной базе" :selected-label="preparedLabels['team:'+form.teamBId]" :excluded-ids="[form.teamAId]" @selected="p=>preparedLabels['team:'+p.id]=p.name??p.id" />
        <UpcomingTeamSummary v-if="slot==='A'?form.teamAId:form.teamBId" :key="slot+':'+(slot==='A'?form.teamAId:form.teamBId)"
          :team-id="slot==='A'?form.teamAId:form.teamBId" :side-label="slot" />
        <div v-for="(p,index) in slot==='A'?form.lineupA:form.lineupB" :key="index">
          <CatalogPicker v-model="p.playerId" kind="players" compact :label="`${slot}: игрок ${index+1}`" :selected-label="preparedLabels['player:'+p.playerId]" :excluded-ids="usedPlayers(p)" @selected="item=>preparedLabels['player:'+item.id]=item.name??item.id" />
          <label class="check-row"><input v-model="p.isStandin" type="checkbox" @change="confirmed=false" />{{slot}}: замена игрока {{index+1}}</label>
        </div>
        <PlayerHistory :slot="slot" :player-ids="(slot==='A'?form.lineupA:form.lineupB).map(p=>p.playerId)" />
        <component :is="(slot==='A'?form.teamAId:form.teamBId)?RoleProfiles:RoleSuggestions" :key="slot+':roles:'+(slot==='A'?form.teamAId:form.teamBId)"
          :team-id="slot==='A'?form.teamAId:form.teamBId" :panda-tournament-id="match.tournament.providerTournamentId" :panda-team-id="upcomingProviderForSlot(match,slot)"
          :lineup="slot==='A'?form.lineupA:form.lineupB" :slot="slot" :disabled="busy||!canManageLineups" confirmation-action="Подтвердить пятёрки и роли" :preserve-manual="confirmed||busy||manualRoles[slot]" :player-labels="preparedLabels"
          @apply="(rows:RoleMember[],automatic?:boolean)=>{if(busy)return;if(automatic===false)manualRoles[slot]=true;if(slot==='A')form.lineupA=rows.map(p=>({...p,playerId:p.playerId??''}));else form.lineupB=rows.map(p=>({...p,playerId:p.playerId??''}));}" />
      </fieldset></div>
      <p v-if="form.teamAId&&form.teamBId"><RouterLink :to="{path:'/compare',query:{teamA:form.teamAId,teamB:form.teamBId}}">Открыть сравнение организаций →</RouterLink></p>
      <p class="hint">Команды A/B не назначают Radiant/Dire. Герои и номер карты будут доступны в редакторе сценария.</p>
      <p class="hint">Период и фильтры сравнения не переносятся в сценарий. Его срез фиксируется при сохранении; период отчёта выбирается отдельно.</p>
      <button v-if="!live" type="submit" :disabled="!input.success">{{busy?'Создание…':'Создать ручной сценарий'}}</button>
    </fieldset></form>
  </details>
</template>
<style scoped>
.catalogue-lock{border:0;padding:0;margin:0}.manual-scenario{margin-top:var(--space-6);border-top:1px solid var(--color-border);padding-top:var(--space-4)}summary{cursor:pointer;min-height:44px}
.manual-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin-block:var(--space-4)}
.comparison-start{overflow-wrap:anywhere}.comparison-start article{min-width:0;background:var(--color-elevated);padding:var(--space-4);border-radius:var(--radius-sm)}.comparison-start h4{margin:0 0 8px}.comparison-start ul{margin:0;padding-left:20px}.comparison-start li{padding-block:3px}
.selected-player-card{padding-block:var(--space-3);border-top:1px solid var(--color-border)}.selected-player-card strong{display:block;margin-bottom:var(--space-2)}
.account-note{display:block;font-size:12px;color:var(--color-muted);margin-block:4px}.account-note.warning{color:var(--color-warning)}.comparison-start button{max-width:100%;white-space:normal}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}.scenario-fields{border:0;padding:0}
label{display:block}.check-row{display:flex;gap:8px;align-items:center;font-size:14px}.check-row input{width:20px;min-height:24px;flex-shrink:0}
@media(max-width:680px){.manual-columns{grid-template-columns:1fr}}
</style>
