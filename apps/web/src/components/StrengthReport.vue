<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {StrengthResponseSchema} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{id:string}>(),from=ref(''),cutoff=ref(''),limit=ref('20'),applied=ref('limit=20');
const {data,isPending,isFetching,isError,error,refetch}=useQuery({queryKey:computed(()=>['strength',props.id,applied.value]),enabled:computed(()=>!!ownerAuth.value),
  queryFn:({signal})=>readCatalog(`teams/${props.id}/strength?${applied.value}`,StrengthResponseSchema,signal)});
const report=computed(()=>data.value?.status!=='unavailable'?data.value:null);
const number=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n);
const rate=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(n);
const available=(us:string)=>dateLabel(new Date(Number(BigInt(us)/1000n)).toISOString());
function apply(){const q=new URLSearchParams({limit:limit.value});
  if(from.value)q.set('fromAt',new Date(from.value+'Z').toISOString());if(cutoff.value)q.set('cutoffAt',new Date(cutoff.value+'Z').toISOString());
  const next=q.toString();if(next===applied.value)void refetch();else applied.value=next;
}
</script>
<template>
  <section class="panel" aria-labelledby="strength-title">
    <p class="eyebrow">Хронология и состав</p><h2 id="strength-title">Elo и сила соперников</h2>
    <p class="warning">Экспериментальный рейтинг не прошёл проверку качества модели. Это очки рейтинга, без прогноза вероятности победы.</p>
    <p class="hint">Пятёрка получает средний рейтинг своих игроков через любые организации. Результат меняет рейтинг после подтверждённого времени доступности. Завершённый состав карты служит историческим фактом, а не доказательством известности до старта.</p>
    <form class="map-filters" @submit.prevent="apply">
      <div><label for="strength-from">Elo: начало отчёта (UTC)</label><input id="strength-from" v-model="from" type="datetime-local" /></div>
      <div><label for="strength-cutoff">Elo: срез (UTC)</label><input id="strength-cutoff" v-model="cutoff" type="datetime-local" /></div>
      <div><label for="strength-limit">Elo: карты отчёта</label><select id="strength-limit" v-model="limit"><option v-for="n in [20,50,100]" :key="n" :value="String(n)">Последние {{n}}</option></select></div>
      <button type="submit">Применить период Elo</button>
    </form>
    <p v-if="isPending" role="status">Рассчитываем историю рейтингов…</p>
    <div v-else-if="isError" role="alert"><p class="error">{{error?.message}}</p><button type="button" @click="refetch()">Повторить Elo</button></div>
    <p v-else-if="data?.status==='unavailable'" role="status" class="warning">{{data.message}}</p>
    <template v-else-if="report">
      <p v-if="report.replayStoppedAtUs" class="warning">Обнаружен конфликт исторических доказательств: {{available(report.replayStoppedAtUs)}}. Более поздние рейтинги недоступны; ранние значения сохранены.</p>
      <p class="hint">Применённый период: {{dateLabel(report.fromAt)}} → {{dateLabel(report.cutoffAt)}}. Последние {{report.filters.limit}} карт организации; доступно до ограничения {{report.coverage.targetMapsBeforeLimit}}. По умолчанию — 90 дней. Предшествующая история всех организаций сохраняется для рейтинга соперников.</p>
      <div class="summary-grid" role="group" aria-label="Рейтинг и сила соперников">
        <p><strong>N = {{report.summary.nRaw}}</strong><span>Наблюдаемые карты организации · WR {{rate(report.summary.winRate)}}</span></p>
        <p><strong>{{report.summary.ratedMaps}}</strong><span>Из них с доступным рейтинговым обновлением</span></p>
        <p><strong>{{number(report.summary.meanOpponentRatingBefore)}}</strong><span>Средний рейтинг соперника до карты · N {{report.summary.ratedMaps}}</span></p>
        <p><strong>{{number(report.summary.meanRatingChange)}}</strong><span>Среднее изменение за карту · N {{report.summary.ratedMaps}}</span></p>
      </div>
      <p v-if="report.status==='insufficient_data'">Недостаточно исторических доказательств для рейтинга в этой выборке. Наблюдаемые исходы организации показаны отдельно.</p>
      <p>Рейтинг игроков последней выбранной карты на срез: {{number(report.summary.lastObservedFiveRating)}}. Актуальный состав организации этим не подтверждён.</p>
      <p class="hint">Базовое начальное значение: {{report.policy.initialRating}}; шаг обновления {{report.policy.k}}; масштаб {{report.policy.scale}}. Параметры зафиксированы для воспроизводимости и ещё не настроены на хронологической проверке.</p>
      <p class="warning">Соперник содержит игроков без предшествующих рейтинговых карт в {{report.coverage.opponentPriorMaps}}/{{report.summary.ratedMaps}} обновлений. Начальное значение — условная отправная точка, не измеренная сила.</p>
      <p class="hint">Источник: локальные pro-карты · синхронизация {{dateLabel(report.summary.dataUpdatedAt)}} · расчёт {{dateLabel(report.snapshotAt)}} · {{report.policy.version}} · ревизия личностей {{report.identityRevision}}.</p>
      <div v-if="report.maps.length" class="table-scroll"><table class="strength-table"><caption class="sr-only">История Elo организации</caption>
        <thead><tr><th>Карта / исход</th><th>Свой рейтинг до / соперника до</th><th>Изменение</th><th>Игроки без истории</th><th>Доступность и состав</th></tr></thead><tbody>
          <tr v-for="m in report.maps" :key="m.matchId"><td>{{m.matchId}} · {{m.won?'победа':'поражение'}}<span class="catalog-id">{{dateLabel(m.startedAt)}} · {{m.side}} · соперник {{m.opponentId??'неизвестен'}}</span></td>
            <template v-if="m.rating"><td>{{number(m.rating.ownBefore)}} / {{number(m.rating.opponentBefore)}}</td><td>{{number(m.rating.change)}}</td>
              <td>{{m.rating.priorPlayers}}/5 своих · {{m.rating.opponentPriorPlayers}}/5 соперника</td><td>{{m.rating.updateApplied?'Результат учтён':'Обновление ещё недоступно на срез'}}<span class="catalog-id">Доступность: {{available(m.rating.availableAtUs)}}</span><span class="catalog-id">{{m.rating.lineupKnownBeforeStart?'Есть доказательство состава до старта':'Состав восстановлен по завершённой карте'}}</span></td></template>
            <td v-else colspan="4" class="warning">Рейтинг неизвестен: не подтверждены историческая личность, pro-статус, исход или доступность состава.</td>
          </tr>
        </tbody></table></div>
      <details><summary>Покрытие расчёта</summary><p>Кандидатов всей истории: {{report.coverage.globalCandidates}}. Исключено: pro неизвестен {{report.coverage.unknownPro}}, не pro {{report.coverage.nonPro}}, конфликт {{report.coverage.conflict}}, незавершённые {{report.coverage.unfinished}}, личности неизвестны на старт {{report.coverage.identityUnavailable}}, недоказанная доступность фактов {{report.coverage.evidenceUnavailable}}.</p>
        <p>Допущено карт во всей истории {{report.coverage.globalReplayMaps}}, применено обновлений {{report.coverage.updatesApplied}}, не применено из-за времени доступности или конфликта {{report.coverage.pendingUpdates}}. Десять игроков одной карты не являются десятью независимыми матчами. Полнота локальной истории не гарантирована.</p>
        <p v-for="m in report.maps" :key="m.matchId">Карта {{m.matchId}} · {{m.source}} · ревизия {{m.dataRevision}} · синхронизация {{dateLabel(m.syncedAt)}} · доказательств личности {{m.identityProofIds.length}}, фактов {{m.factProofIds.length}}.</p>
      </details>
      <button type="button" :disabled="isFetching" @click="refetch()">{{isFetching?'Обновление…':'Перечитать Elo'}}</button>
    </template>
  </section>
</template>
