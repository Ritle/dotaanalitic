<script setup lang="ts">
import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {RoleProfilesReportSchema} from '@dota/contracts';
import type {RosterContext} from '../../../api/src/modules/catalog/roster-context-contract';
import {ownerAuth} from '../auth';
import {readCatalog,dateLabel} from '../catalog';
import {roleName} from '../role-suggestions';
import {roleSourceName} from '../role-editor';
import {roleCandidateStatus} from '../role-source-status';
import {rosterRoleBatches,rosterRoleHints,MAX_ROSTER_ROLE_MEMBERS} from '../roster-role-hints';
const props=defineProps<{teamId:string;members:RosterContext['members'];cutoffAt:string}>();
const batches=computed(()=>rosterRoleBatches(props.members));
const identityKey=computed(()=>props.members.map(m=>`${m.playerId??''}:${m.accountId}:${m.identityStatus}`).sort().join('|'));
const query=useQuery({queryKey:computed(()=>['role-profiles',props.teamId,'roster-card',identityKey.value]),
 enabled:computed(()=>!!ownerAuth.value&&batches.value.length>0),staleTime:60_000,retry:false,
 queryFn:async({signal})=>{
  const teamId=props.teamId,groups=batches.value.map(b=>[...b]),cutoffAt=props.cutoffAt,reports=[];
  for(const playerIds of groups){
   const report=await readCatalog('lineup-role-profiles',RoleProfilesReportSchema,signal,{method:'POST',
    headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({teamId,playerIds,cutoffAt,refreshProfiles:false})});
   if(report.teamId!==teamId||report.history.cutoffAt!==cutoffAt||report.players.length!==playerIds.length||
    new Set(report.players.map(p=>p.playerId)).size!==playerIds.length||report.players.some(p=>!playerIds.includes(p.playerId)))throw Error('Ответ о ролях не соответствует выбранным игрокам. Перечитайте подсказки.');
   reports.push(report);
  }
  return {reports,cutoffAt};
 }});
const reports=computed(()=>batches.value.length&&!query.isError.value?query.data.value?.reports??[]:[]);
const hints=computed(()=>rosterRoleHints(props.members,reports.value.flatMap(r=>r.players)));
const orderedMembers=computed(()=>[...props.members].sort((a,b)=>(hints.value.get(a.playerId??'')?.rolePos??99)-(hints.value.get(b.playerId??'')?.rolePos??99)));
const evidence=(id:string)=>reports.value.find(r=>r.players.some(p=>p.playerId===id));
</script>
<template>
 <p class="hint">Роли — текущие подсказки: PandaScore → STRATZ → pro-история. Их можно исправить при выборе пятёрки для сравнения.</p>
 <p v-if="query.isFetching.value" role="status">Читаем подсказки ролей…</p>
 <p v-if="query.error.value" role="alert" class="error">{{query.error.value.message}} <button type="button" @click="query.refetch()">Повторить чтение ролей</button></p>
 <p v-if="members.length>MAX_ROSTER_ROLE_MEMBERS" class="hint">В реестре больше {{MAX_ROSTER_ROLE_MEMBERS}} игроков. Для проверки ролей выберите пятёрку в сравнении.</p>
 <ul><li v-for="member in orderedMembers" :key="member.accountId">
  <strong>{{member.playerId&&hints.get(member.playerId)?.rolePos?roleName(hints.get(member.playerId)!.rolePos!):'Роль не определена'}}</strong> —
  <RouterLink v-if="member.playerId" :to="`/players/${member.playerId}`">{{member.name}}</RouterLink><strong v-else>{{member.name}}</strong>
  <span v-if="member.localName&&member.localName!==member.name" class="hint"> · в локальном каталоге: {{member.localName}}</span>
  <a :href="`https://www.opendota.com/players/${member.accountId}`" target="_blank" rel="noopener noreferrer" class="account">Steam32 {{member.accountId}}</a>
  <span v-if="member.identityStatus!=='verified'" class="hint">{{member.identityStatus==='conflict'?'Конфликт личности — локальная карточка не подставлена':'Аккаунт пока не связан с локальным игроком'}}</span>
  <template v-if="member.playerId&&hints.get(member.playerId)">
   <p v-if="hints.get(member.playerId)!.editorSource" class="hint">Подсказка: {{roleSourceName(hints.get(member.playerId)!.editorSource!)}}.</p>
   <p v-if="hints.get(member.playerId)!.editorConflict" class="warning">Источники расходятся. Показана подсказка по приоритету; проверьте роль.</p>
   <p v-if="hints.get(member.playerId)!.editorDuplicate" class="warning">Эта роль предложена нескольким игрокам. Пятёрка автоматически не расставляется.</p>
   <details><summary>Основания роли: {{member.name}}</summary>
    <p>Pro-карт с оценкой роли: {{hints.get(member.playerId)!.historyMaps}} · {{hints.get(member.playerId)!.historyScope==='selected_team'?'в этой организации':'за все организации'}}.</p>
    <p v-if="hints.get(member.playerId)!.historyMaps<3" class="hint">Мало карт с оценкой роли.</p>
    <p v-if="hints.get(member.playerId)!.reasons.includes('UNVALIDATED_HEURISTIC')" class="hint">История включает оценку по линии/GPM; это не подтверждённая позиция.</p>
    <p v-for="(candidate,i) in hints.get(member.playerId)!.candidates" :key="i">{{roleSourceName(candidate.source)}}:
     {{candidate.eligible?candidate.roles.map(roleName).join(' / '):roleCandidateStatus(evidence(member.playerId)!,hints.get(member.playerId)!,candidate)??'Нет однозначной подсказки'}}</p>
    <p v-for="source in evidence(member.playerId)?.sources.filter(s=>s.provider==='pandascore'||s.sourceKey===`stratz:player:${member.accountId}`)??[]" :key="source.sourceKey" class="hint">
     {{roleSourceName(source.provider)}} · {{source.status==='ready'?'актуальный кэш':source.status==='stale'?'устаревший кэш':'нет доступных данных'}} · Получено: {{dateLabel(source.fetchedAt)}}.</p>
   </details>
  </template>
 </li></ul>
 <template v-if="reports.length">
  <p class="hint">История: {{dateLabel(reports[0]!.history.fromAt)}} — строго до {{dateLabel(query.data.value!.cutoffAt)}} · до 20 pro-карт на игрока. Проверено: {{dateLabel(reports.at(-1)!.snapshotAt)}}.</p>
  <p class="hint">Чтение использует локальную историю и сохранённые профили API. Для обновления профилей и ручных правок откройте сравнение. Подсказка не подтверждает участие или роль в прошлой карте; V1 Elo от неё не зависит.</p>
 </template>
</template>
<style scoped>
ul{padding-left:20px}li{margin-block:12px;overflow-wrap:anywhere}.account{display:block;font-size:13px;margin-block:4px}.hint{font-size:13px}summary{cursor:pointer}button{max-width:100%;white-space:normal}
</style>
