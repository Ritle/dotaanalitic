<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { CatalogListSchema, type CatalogKind } from '@dota/contracts';
import { readCatalog, dateLabel } from '../catalog';
import { ownerAuth } from '../auth';
const kinds: {id:CatalogKind;label:string}[]=[{id:'teams',label:'Команды'},{id:'players',label:'Игроки'},{id:'heroes',label:'Герои'}];
const kind=ref<CatalogKind>('teams'), draft=ref(''), term=ref(''), offset=ref(0);
const {data,isPending,isFetching,isError,error,refetch}=useQuery({
  queryKey:computed(()=>['catalog','list',kind.value,term.value,offset.value]), enabled:computed(()=>!!ownerAuth.value),
  queryFn:({signal})=>readCatalog(`${kind.value}?${new URLSearchParams({query:term.value,limit:'25',offset:String(offset.value)})}`,CatalogListSchema,signal)
});
function search(){
  const next=draft.value.trim();
  if(offset.value===0 && term.value===next) void refetch();
  else {offset.value=0;term.value=next;}
}
watch(kind,()=>{offset.value=0;draft.value='';term.value='';});
</script>

<template>
  <section class="panel" aria-labelledby="catalog-title">
    <div class="account-row"><h2 id="catalog-title">Справочники</h2><span class="badge">Локальная база</span></div>
    <p>Найдите организацию, игрока или героя по имени и ID. Команды также доступны по тегу.</p>
    <div class="catalog-tabs" role="group" aria-label="Раздел справочника">
      <button v-for="entry in kinds" :key="entry.id" type="button" :aria-pressed="kind===entry.id" @click="kind=entry.id">{{entry.label}}</button>
    </div>
    <form class="search-form" @submit.prevent="search">
      <label for="catalog-search">Имя, тег или ID</label>
      <div class="search-row"><input id="catalog-search" v-model="draft" maxlength="80" type="search" autocomplete="off"><button type="submit">Найти</button></div>
    </form>
    <p class="hint">Источник: локальный справочник. Отметка синхронизации и время изменения записи — разные поля. Полнота каталога не гарантируется.</p>
    <p v-if="isPending" role="status">Загружаем справочник…</p>
    <div v-else-if="isError" role="alert"><p class="error">{{error?.message}}</p><button type="button" @click="refetch()">Повторить</button></div>
    <template v-else-if="data">
      <p class="hint" role="status">{{isFetching?'Обновление…':`Записей на странице: ${data.items.length}`}} · Поиск: {{data.filters.query || 'все записи'}} · Прочитано: {{dateLabel(data.computedAt)}}</p>
      <p v-if="!data.items.length">Ничего не найдено. В локальной базе нет подходящих записей; загрузка из источника выполняется отдельно.</p>
      <div v-else class="table-scroll">
        <table><caption class="sr-only">Результаты поиска: {{kinds.find(k=>k.id===kind)?.label}}</caption>
          <thead><tr><th scope="col">Название / ID</th><th scope="col">Синхронизация</th><th scope="col">Изменение записи</th></tr></thead>
          <tbody><tr v-for="entry in data.items" :key="entry.id">
            <td><RouterLink v-if="kind!=='heroes'" :to="`/${kind}/${entry.id}`">{{entry.name}}</RouterLink><strong v-else>{{entry.name}}</strong>
              <span class="catalog-id">{{entry.secondary || (kind==='players'?'Canonical player':'Без тега')}} · ID {{entry.id}}</span></td>
            <td>{{dateLabel(entry.syncedAt)}}</td><td>{{dateLabel(entry.metadataUpdatedAt)}}</td>
          </tr></tbody>
        </table>
      </div>
      <nav class="pagination" aria-label="Страницы результатов">
        <button type="button" :disabled="offset===0 || isFetching" @click="offset-=25">Назад</button>
        <span>Страница {{offset/25+1}}</span>
        <button type="button" :disabled="!data.hasMore || offset>=10000 || isFetching" @click="offset+=25">Далее</button>
        <button type="button" :disabled="isFetching" @click="refetch()">Перечитать базу</button>
      </nav>
    </template>
  </section>
</template>
