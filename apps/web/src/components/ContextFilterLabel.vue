<script setup lang="ts">
import type {ContextKind} from '../../../api/src/modules/catalog/context-catalog-contract';
import {useContextLabel,emptyContextLabel} from '../context-catalog';
import {dateLabel} from '../catalog';
const props=defineProps<{kind:ContextKind;id?:string|null;emptyLabel?:string}>();
const {name,query}=useContextLabel(()=>props.kind,()=>props.id??'');
</script>
<template><div class="context-label"><span>{{id?name:emptyLabel??emptyContextLabel(kind)}}</span><details v-if="id"><summary>Ключ фильтра</summary><span>Локальный ID: {{id}}</span><span v-if="query.data.value"> · Название прочитано {{dateLabel(query.data.value.readAt)}}.</span><button v-if="query.error.value" type="button" @click="query.refetch()">Повторить название фильтра</button></details></div></template>
<style scoped>.context-label{display:inline-block;vertical-align:top;max-width:100%;overflow-wrap:anywhere}summary{cursor:pointer;min-height:44px;padding-block:8px;font-size:12px}details{font-size:12px}</style>
