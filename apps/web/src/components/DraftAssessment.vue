<script setup lang="ts">
import type {DraftAssessment} from '@dota/contracts';
import DraftDisplayLabels from './DraftDisplayLabels.vue';
import ReportEntityLabel from './ReportEntityLabel.vue';
import ContextFilterLabel from './ContextFilterLabel.vue';
import {dateLabel} from '../catalog';
defineProps<{assessment:DraftAssessment;saved?:boolean;heroLabels?:Record<string,string>;compact?:boolean}>();
const reason=(value:string|null)=>value==='CONFLICT'?'Источники противоречат друг другу':value==='MAP_TIME_UNKNOWN'?'Не задано начало карты':value==='HERO_ELIGIBILITY_UNKNOWN'?'Нет достаточных подтверждений':value??'';
</script>
<template>
  <section class="draft-assessment" :class="{compact}" :aria-label="saved?'Сохранённая проверка драфта':'Проверка доступности драфта'">
    <h3>{{saved?'Проверка на момент сохранения':'Проверка доступности'}}</h3>
    <p :class="assessment.status==='blocked'?'error':'warning'">{{assessment.status==='blocked'?'Есть подтверждённый запрет. Сохранение заблокировано.':assessment.status==='unknown'?'Доступность не установлена полностью. Неизвестные герои разрешены в сценарии с предупреждением.':'Указанные герои доступны по проверенным источникам.'}}</p>

    <p v-if="compact&&assessment.patch.value===null" class="hint">Для даты карты не подтверждён патч. Это не ошибка заполнения драфта.</p>
    <component :is="compact?'details':'div'" class="assessment-details"><summary v-if="compact">Герои, патч и источники проверки</summary>
    <p>Назначено {{assessment.assignedHeroes}} / 10. {{assessment.fullDraft?'Полный набор героев.':'Драфт неполный.'}} Прогноз после драфта недоступен. Порядок пиков и банов не проверялся.</p>
    <DraftDisplayLabels :provided-labels="heroLabels" :hero-ids="assessment.heroes.map(h=>String(h.heroId))" v-slot="{labels}">
    <p class="hint">{{dateLabel(assessment.checkedAt)}} · знания до {{dateLabel(assessment.knowledgeAt)}} · revision реестра {{assessment.registryRevision}}. Патч: <ContextFilterLabel kind="patches" :id="assessment.patch.value" empty-label="не подтверждён" />; лига: <ContextFilterLabel kind="leagues" :id="assessment.leagueId" empty-label="неизвестна" />; начало карты: {{dateLabel(assessment.mapTime)}}.</p>
    <p v-if="assessment.patch.value===null" class="warning">Патч не установлен по подтверждённым временным границам.</p>
    <p v-if="assessment.leagueId===null" class="warning">Лига неизвестна: турнирные ограничения не подтверждены.</p>
    <ul><li v-for="h in assessment.heroes" :key="h.heroId" :data-assessment-hero-id="h.heroId">{{h.teamSlot}} · {{h.action==='pick'?`роль ${h.rolePos}`:'бан'}} · <ReportEntityLabel kind="heroes" :id="String(h.heroId)" :name="labels['hero:'+h.heroId]" />:
      <strong :class="h.decision.value===false?'error':h.decision.value===null?'warning':''">{{h.decision.value===true?'доступен':h.decision.value===false?'недоступен':'неизвестно'}}</strong><span v-if="h.decision.reason"> · {{reason(h.decision.reason)}}</span>
    </li></ul>
    <details v-if="assessment.proofs.length"><summary>Источники проверки</summary><div v-for="p in assessment.proofs" :key="p.kind+p.id">
      <p>{{p.kind==='patch'?'Патч':'Герой'}} · {{p.source}} · {{p.reviewState==='conflict'?'конфликт':'подтверждённый источник'}}<br /><span class="evidence-ref">{{p.evidenceRef}}</span></p>
      <p class="hint">Событие: {{dateLabel(p.eventAt)}}; известно: {{dateLabel(p.knownAt)}}; получено: {{dateLabel(p.fetchedAt)}}.</p>
    </div></details>
    </DraftDisplayLabels>
    </component>
  </section>
</template>
<style scoped>.draft-assessment{margin-block:20px;border-top:1px solid var(--color-border);padding-top:16px}li,.evidence-ref{overflow-wrap:anywhere}summary{min-height:44px;cursor:pointer}.compact{margin-block:12px;padding-top:12px}.compact h3{font-size:15px;margin-block:0 8px}.compact p{font-size:13px;margin-block:8px}.compact summary{min-height:36px}</style>
