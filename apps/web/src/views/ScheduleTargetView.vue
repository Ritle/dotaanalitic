<script setup lang="ts">
import {computed} from 'vue';
import {useRoute} from 'vue-router';
import {useQuery} from '@tanstack/vue-query';
import {V1ScheduleTargetSavedSchema} from '@dota/contracts';
import {scheduleTargetCall} from '../schedule-targets';
import ScheduleTargetDetails from '../components/ScheduleTargetDetails.vue';
import ScheduledForecastPanel from '../components/ScheduledForecastPanel.vue';
import ScheduledLifecyclePanel from '../components/ScheduledLifecyclePanel.vue';
const route=useRoute(),id=computed(()=>String(route.params.requestId));
const query=useQuery({queryKey:computed(()=>['schedule-target',id.value]),queryFn:({signal})=>scheduleTargetCall('schedule-targets/'+encodeURIComponent(id.value),V1ScheduleTargetSavedSchema,signal)});
</script>
<template><main class="panel" style="overflow-wrap:anywhere"><RouterLink to="/upcoming">← Расписание</RouterLink><h1>Назначение будущей карты</h1>
  <p v-if="query.isFetching.value" role="status">Загрузка…</p><p v-if="query.error.value" role="alert" class="error">{{query.error.value.message}}</p>
  <ScheduleTargetDetails v-if="query.data.value?.record.request.requestId===id" :saved="query.data.value" />
  <ScheduledLifecyclePanel v-if="query.data.value?.record.request.requestId===id" :key="'lifecycle-'+id" :target-id="id" />
  <ScheduledForecastPanel v-if="query.data.value?.record.request.requestId===id" :key="id" :target="query.data.value" />
  <p>Эта редакция сохранена навсегда. Последующие переносы, замены участников и результаты не переписывают её.</p>
</main></template>
