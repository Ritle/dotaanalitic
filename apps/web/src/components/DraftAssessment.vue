<script setup lang="ts">
import type {DraftAssessment} from '@dota/contracts';
import {dateLabel} from '../catalog';
defineProps<{assessment:DraftAssessment;saved?:boolean}>();
const reason=(value:string|null)=>value==='CONFLICT'?'Источники противоречат друг другу':value==='MAP_TIME_UNKNOWN'?'Не задано начало карты':value==='HERO_ELIGIBILITY_UNKNOWN'?'Нет достаточных подтверждений':value??'';
</script>
<template>
  <section class="draft-assessment" :aria-label="saved?'Сохранённая проверка драфта':'Проверка доступности драфта'">
    <h3>{{saved?'Проверка на момент сохранения':'Проверка доступности'}}</h3>
    <p :class="assessment.status==='blocked'?'error':'warning'">{{assessment.status==='blocked'?'Есть подтверждённый запрет. Сохранение заблокировано.':assessment.status==='unknown'?'Доступность не установлена полностью. Неизвестные герои разрешены в сценарии с предупреждением.':'Указанные герои доступны по проверенным источникам.'}}</p>
    <p>Назначено {{assessment.assignedHeroes}} / 10. {{assessment.fullDraft?'Полный набор героев.':'Драфт неполный.'}} Прогноз недоступен. Порядок пиков и банов не проверялся.</p>
    <p class="hint">{{dateLabel(assessment.checkedAt)}} · знания до {{dateLabel(assessment.knowledgeAt)}} · revision реестра {{assessment.registryRevision}}. Патч: {{assessment.patch.value??'неизвестно'}}; лига: {{assessment.leagueId??'неизвестно'}}; начало карты: {{dateLabel(assessment.mapTime)}}.</p>
    <p v-if="assessment.patch.value===null" class="warning">Патч не установлен по подтверждённым временным границам.</p>
    <p v-if="assessment.leagueId===null" class="warning">Лига неизвестна: турнирные ограничения не подтверждены.</p>
    <ul><li v-for="h in assessment.heroes" :key="h.heroId">{{h.teamSlot}} · {{h.action==='pick'?`роль ${h.rolePos}`:'бан'}} · герой #{{h.heroId}}:
      <strong :class="h.decision.value===false?'error':h.decision.value===null?'warning':''">{{h.decision.value===true?'доступен':h.decision.value===false?'недоступен':'неизвестно'}}</strong><span v-if="h.decision.reason"> · {{reason(h.decision.reason)}}</span>
    </li></ul>
    <details v-if="assessment.proofs.length"><summary>Источники проверки</summary><div v-for="p in assessment.proofs" :key="p.kind+p.id">
      <p>{{p.kind==='patch'?'Патч':'Герой'}} · {{p.source}} · {{p.reviewState==='conflict'?'конфликт':'подтверждённый источник'}}<br /><span class="evidence-ref">{{p.evidenceRef}}</span></p>
      <p class="hint">Событие: {{dateLabel(p.eventAt)}}; известно: {{dateLabel(p.knownAt)}}; получено: {{dateLabel(p.fetchedAt)}}.</p>
    </div></details>
  </section>
</template>
<style scoped>.draft-assessment{margin-block:20px;border-top:1px solid var(--color-border);padding-top:16px}li,.evidence-ref{overflow-wrap:anywhere}summary{min-height:44px;cursor:pointer}</style>
