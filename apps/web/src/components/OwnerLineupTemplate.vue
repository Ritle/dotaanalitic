<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {CatalogIdSchema} from '@dota/contracts';
import {LineupTemplateSchema,LineupTemplateReportSchema} from '../../../api/src/modules/catalog/lineup-templates-contract';
import {accountAccess,ownerAuth} from '../auth';
import {readCatalog,dateLabel,CatalogRequestError} from '../catalog';
import {templateLineup,applyOwnerTemplate,sameTemplateRoles} from '../owner-lineup-template';
import type {RoleMember} from '../role-suggestions';
const props=defineProps<{teamId:string;lineup:RoleMember[];slot:'A'|'B';preserveManual:boolean}>();
const emit=defineEmits<{apply:[lineup:RoleMember[]]}>(),cache=useQueryClient();
const valid=computed(()=>CatalogIdSchema.safeParse(props.teamId).success&&!!templateLineup(props.lineup));
const key=computed(()=>['owner-lineup-template',props.teamId]);
const query=useQuery({queryKey:key,enabled:valid,staleTime:60_000,queryFn:({signal})=>readCatalog(`teams/${props.teamId}/lineup-template`,LineupTemplateReportSchema,signal)});
const current=computed(()=>query.data.value?.current),saving=ref(false),needsReview=ref(false),failure=ref('');
const ready=computed(()=>valid.value&&!query.isPending.value&&!query.isFetching.value&&!query.isError.value&&!needsReview.value&&!saving.value);
const matching=computed(()=>!!applyOwnerTemplate(props.teamId,props.lineup,current.value));
let applied='',pending:{text:string;id:string}|null=null,disposed=false;onBeforeUnmount(()=>{disposed=true;});
watch([current,ready,()=>props.preserveManual,()=>props.lineup.map(p=>p.playerId).join(':'),()=>props.teamId],()=>{
 if(props.preserveManual||!ready.value||!current.value)return;
 const rows=applyOwnerTemplate(props.teamId,props.lineup,current.value),stamp=JSON.stringify([props.teamId,current.value.revision,props.lineup.map(p=>p.playerId)]);
 if(rows&&applied!==stamp){applied=stamp;emit('apply',rows);}
},{immediate:true});
async function reread(){const result=await query.refetch();if(!result.isError){needsReview.value=false;failure.value='';pending=null;}}
async function saveReviewed(){
 if(accountAccess.value?.role!=='owner')throw Error('Сохранять пятёрки и роли может только владелец.');
 const reviewedTeam=props.teamId,reviewedRows=JSON.stringify(templateLineup(props.lineup));
 if(query.isPending.value||query.isFetching.value)await query.refetch({cancelRefetch:false});
 if(disposed||props.teamId!==reviewedTeam||JSON.stringify(templateLineup(props.lineup))!==reviewedRows)throw Error('Выбранная пятёрка изменилась. Проверьте её заново.');
 if(!ready.value)throw Error('Дождитесь чтения шаблона; при ошибке перечитайте его и подтвердите выбор заново.');
 const lineup=templateLineup(props.lineup);if(!lineup)throw Error('Нужны пять разных игроков и роли 1–5.');
 if(sameTemplateRoles(props.teamId,props.lineup,current.value))return current.value!;
 const teamId=props.teamId,queryKey=[...key.value],raw={expectedRevision:current.value?.revision??0,lineup,confirmedByOwner:true};
 const text=JSON.stringify([teamId,raw]);if(pending?.text!==text)pending={text,id:crypto.randomUUID()};saving.value=true;failure.value='';
 try{
  const saved=await readCatalog(`teams/${teamId}/lineup-template`,LineupTemplateSchema,new AbortController().signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({...raw,requestId:pending.id})});
  if(disposed||teamId!==props.teamId)throw Error('Выбранная команда изменилась. Проверьте состав заново.');
  const previous=query.data.value,history=[saved,...(previous?.history??[]).filter(r=>r.revision!==saved.revision)];
  cache.setQueryData(queryKey,{teamId,current:saved,history:history.slice(0,20),hasMore:!!previous?.hasMore||history.length>20});pending=null;return saved;
 }catch(e){failure.value=e instanceof Error?e.message:'Не удалось сохранить шаблон владельца.';if(e instanceof CatalogRequestError&&e.status===409){needsReview.value=true;pending=null;}throw e;}
 finally{saving.value=false;}
}
const confirmed=computed(()=>ready.value&&sameTemplateRoles(props.teamId,props.lineup,current.value));
defineExpose({ready,confirmed,saveReviewed});
</script>
<template>
 <section class="owner-template" :aria-label="`Шаблон владельца ${slot}`">
  <strong>Шаблон владельца · {{slot}}</strong>
  <p v-if="query.isFetching.value" role="status">Читаем сохранённые назначения…</p>
  <template v-else-if="current">
   <p class="hint">Подтвердил {{current.confirmedBy.login}} · {{dateLabel(current.confirmedAt)}} · редакция {{current.revision}}</p>
   <p v-if="!matching" class="warning">Шаблон сохранён для другой пятёрки. Новый состав должен проверить владелец.</p>
   <p v-else-if="sameTemplateRoles(teamId,lineup,current)" class="hint">Ожидаемые роли владельца подставлены.</p>
   <p v-else class="hint">Ожидаемые роли изменены. Сохраните их общим подтверждением пятёрок.</p>
  </template>
  <p v-else-if="!query.isError.value" class="hint">Сохранённого шаблона ещё нет. Владелец сохранит назначения общим подтверждением пятёрок.</p>
  <p v-if="accountAccess?.role==='owner'" class="hint">Владелец: роли сохраняются общим подтверждением пятёрок.</p>
  <p v-else class="hint">Просмотр назначений владельца. Изменять и подтверждать их может только владелец.</p>
  <p v-if="query.error.value||failure" role="alert" class="error">{{failure||query.error.value?.message}} <button type="button" :disabled="saving||query.isFetching.value" @click="reread">Перечитать шаблон {{slot}}</button></p>
 </section>
</template>
<style scoped>.owner-template{margin-top:var(--space-3);border-top:1px solid var(--color-border);padding-top:var(--space-3);overflow-wrap:anywhere}p{margin-block:var(--space-2)}</style>
