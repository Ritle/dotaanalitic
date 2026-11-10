<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {RosterContextSchema} from '../../../api/src/modules/catalog/roster-context-contract';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{kind:'teams'|'players';id:string}>(),cache=useQueryClient(),busy=ref(false),error=ref('');
const key=computed(()=>['roster-context',props.kind,props.id]),path=computed(()=>`${props.kind}/${encodeURIComponent(props.id)}/roster-context`);
const query=useQuery({queryKey:key,enabled:computed(()=>!!ownerAuth.value),
 queryFn:({signal})=>readCatalog(path.value,RosterContextSchema,signal)});
const report=computed(()=>query.data.value),linked=computed(()=>report.value?.members.filter(p=>p.identityStatus==='verified').length??0);
async function refresh(){
 if(busy.value)return;
 const requestKey=[...key.value],requestPath=path.value,csrf=ownerAuth.value?.csrfToken;busy.value=true;error.value='';
 try{await cache.cancelQueries({queryKey:requestKey,exact:true});
  const value=await readCatalog(requestPath+'/refresh',RosterContextSchema,new AbortController().signal,{method:'POST',
  headers:{'content-type':'application/json','x-csrf-token':csrf??''},body:'{}'});
  // All cards read one registry. Mark other loaded contexts stale when it is checked.
  await cache.cancelQueries({queryKey:requestKey,exact:true});if(!csrf||ownerAuth.value?.csrfToken!==csrf)return;
  cache.setQueryData(requestKey,value);await cache.invalidateQueries({queryKey:['roster-context'],
   predicate:q=>q.queryKey[1]!==requestKey[1]||q.queryKey[2]!==requestKey[2]});
 }catch(e){error.value=e instanceof Error?e.message:'Не удалось обновить сведения о составе.';}finally{busy.value=false;}
}
</script>
<template>
 <section class="current-roster" :aria-label="kind==='teams'?'Состав по OpenDota':'Команда по OpenDota'">
  <h3>{{kind==='teams'?'Состав по OpenDota':'Команда по OpenDota'}}</h3>
  <p v-if="query.isPending.value" role="status">Читаем сведения о составе…</p>
  <p v-if="query.error.value||error" role="alert" class="error">{{error||query.error.value?.message}}</p>
  <template v-if="report">
   <p v-if="kind==='players'&&report.accountId" class="hint">Подтверждённый аккаунт: <a :href="`https://www.opendota.com/players/${report.accountId}`" target="_blank" rel="noopener noreferrer">Steam32 {{report.accountId}}</a>.</p>
   <p v-if="report.status==='team_unlinked'" class="hint">Эта организация пока не сопоставлена с числовой записью OpenDota. По названию состав не подставляется.</p>
   <p v-else-if="report.status==='identity_unresolved'" class="warning">{{report.identityStatus==='conflict'?'Есть конфликт привязки аккаунта.':'Аккаунт игрока не подтверждён однозначно.'}} Определять команду по совпадению ника нельзя.</p>
   <template v-else>
    <p v-if="report.source.status==='not_loaded'" class="hint">Реестр ещё не загружен. Нажмите «Обновить из OpenDota».</p>
    <p v-else-if="report.source.status==='unavailable'" class="warning">Сохранённые сведения не прошли проверку. Состав по ним не показывается; повторите обновление позже.</p>
    <p v-else-if="report.source.status==='stale'" class="warning">Сведения устарели. Ниже последняя сохранённая запись; перед выбором состава обновите источник.</p>
    <p v-if="report.status==='not_listed'" class="hint">{{kind==='teams'?'В реестре нет игроков этой организации. Это не означает, что команда не существует.':'Реестр не указывает команду для подтверждённого аккаунта. Это не означает, что игрок без команды.'}}</p>
    <template v-if="report.status==='listed'">
     <template v-if="kind==='players'&&report.team">
      <p class="membership"><RouterLink v-if="report.team.id" :to="`/teams/${report.team.id}`">{{report.team.name||'Команда без названия'}}</RouterLink>
       <a v-else :href="`https://www.opendota.com/teams/${report.team.providerTeamId}`" target="_blank" rel="noopener noreferrer">{{report.team.name||'Команда без названия'}} · OpenDota</a></p>
     </template>
     <template v-else>
      <p>В реестре: {{report.members.length}} игроков · подтверждённых локальных аккаунтов: {{linked}}.</p>
      <ul><li v-for="member in report.members" :key="member.accountId">
       <RouterLink v-if="member.playerId" :to="`/players/${member.playerId}`">{{member.name}}</RouterLink><strong v-else>{{member.name}}</strong>
       <span v-if="member.localName&&member.localName!==member.name" class="hint"> · в локальном каталоге: {{member.localName}}</span>
       <a :href="`https://www.opendota.com/players/${member.accountId}`" target="_blank" rel="noopener noreferrer" class="account">Steam32 {{member.accountId}}</a>
       <span v-if="member.identityStatus!=='verified'" class="hint">{{member.identityStatus==='conflict'?'Конфликт личности — локальная карточка не подставлена':'Аккаунт пока не связан с локальным игроком'}}</span>
      </li></ul>
     </template>
    </template>
    <div v-if="kind==='teams'&&report.team" class="lineup-guidance">
     <p v-if="report.members.length===0" class="warning">Пятёрка не определена. Выберите игроков вручную, если хотите разобрать свой состав.</p>
     <p v-else-if="report.members.length<5" class="warning">Список неполный: {{report.members.length}} из 5 игроков. Остальные участники не подставляются из прошлых матчей.</p>
     <p v-else-if="report.members.length>5" class="warning">В списке больше пяти игроков. Выберите нужную пятёрку для сравнения.</p>
     <p v-else class="hint">Пять записей не подтверждают участие в будущей встрече. Проверьте игроков перед сравнением.</p>
     <p class="hint">Статус активности команды по этому реестру не определяется. Даже свежая запись может относиться к прежнему составу.</p>
     <p><a :href="`https://www.opendota.com/teams/${report.team.providerTeamId}`" target="_blank" rel="noopener noreferrer">Проверить команду в OpenDota</a></p>
     <p><RouterLink :to="{path:'/compare',query:{teamA:id}}">Выбрать пятёрку для сравнения</RouterLink></p>
    </div>
    <p v-if="report.source.fetchedAt" class="hint">Источник: OpenDota · реестр профессиональных игроков · получено {{dateLabel(report.source.fetchedAt)}}.</p>
    <p class="hint">Это сведения реестра о принадлежности к команде, а не заявка на конкретную встречу. Дата трансфера источником не сообщается. Для прогноза действует выбранная вами пятёрка.</p>
   </template>
   <p v-if="report.source.refreshFailed" role="status" class="warning">Источник не удалось обновить или он уже обновляется. Сохранённые сведения не заменены непроверенным ответом.</p>
   <button type="button" :disabled="busy||!report.canRefresh" @click="refresh">{{busy?'Обновление…':'Обновить из OpenDota'}}</button>
   <p v-if="report.canRefresh" class="hint">Общий кэш на один час для всех карточек. Актуальный кэш используется без нового запроса к OpenDota.</p>
  </template>
  <button v-if="query.error.value" type="button" @click="query.refetch()">Повторить чтение</button>
 </section>
</template>
<style scoped>
.current-roster{border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4);margin-block:var(--space-4);overflow-wrap:anywhere}
h3{margin-top:0}ul{padding-left:20px}li{margin-block:12px}.account{display:block;font-size:13px;margin-block:4px}.membership{font-size:18px;font-weight:600}button{max-width:100%;white-space:normal}
</style>
