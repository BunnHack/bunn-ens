<script setup lang="ts">
import { computed } from 'vue'
import type { TrackPoint } from '../data/wnc2'
import { windPressureAudit } from '../data/wm6-audit'
const props = defineProps<{ points: TrackPoint[]; forecastZero?: string }>()
const audit = computed(() => windPressureAudit(props.points))
const rows = computed(() => [
  { label: '最低氣壓點', point: audit.value.minimumPressure },
  { label: '最大風速點', point: audit.value.maximumWind },
].filter((row): row is { label: string; point: TrackPoint } => row.point !== null))
const wind = (value: number) => Number.isFinite(value) && value >= 0 ? value.toFixed(1) : '—'
</script>

<template>
  <section class="wm6-audit" aria-label="WM-6 原始風壓數值核對">
    <p v-if="audit.minimumPressure" class="wm6-audit-pair">目前圖中最低氣壓 <strong>{{ audit.minimumPressure.pressure!.toFixed(1) }} hPa</strong>，同點風速 <strong>{{ wind(audit.minimumPressure.wind) }} kt</strong>。</p>
    <details><summary>原始 kt / hPa 核對（同一成員、同一時刻）</summary>
      <p>保留供應商的 max_wind_kt 與 min_mslp_hpa 原值，未互換欄位、未乘單位係數，也不依氣壓推算風速。氣壓與風速沒有固定對照；最低氣壓與最大風速也可能來自不同成員或時刻。以下僅為目前圖中 0–312h 的資料，不代表全模式極值。</p>
      <p v-if="forecastZero">時效基準 forecast_zero：{{ forecastZero }}；+h 以此為準，不一定等於發布起報時間。</p>
      <div class="wm6-audit-table"><table><thead><tr><th>核對點</th><th>原始 ID</th><th>成員</th><th>時效</th><th>有效時間 UTC</th><th>kt</th><th>hPa</th></tr></thead><tbody><tr v-for="row in rows" :key="row.label"><td>{{ row.label }}</td><td>{{ row.point.trackId }}</td><td>{{ row.point.sample }}</td><td>+{{ row.point.leadHours }}h</td><td>{{ row.point.validTime }}</td><td>{{ wind(row.point.wind) }}</td><td>{{ row.point.pressure?.toFixed(1) ?? '—' }}</td></tr></tbody></table></div>
      <p>風速缺值 {{ audit.missingWind }} 點；氣壓缺值 {{ audit.missingPressure }} 點。低壓與弱風的組合若與其他資料有明顯落差，仍需供應商確認風場定義、取樣與校準，不能只憑風壓組合判定是單位錯誤。</p>
    </details>
  </section>
</template>

<style scoped>
.wm6-audit { width: 100%; max-width: 870px; font-size: 11px; line-height: 1.8; margin-top: 12px; border: 1px solid #b9ccd8; border-radius: 8px; padding: 12px; min-width: 0; box-sizing: border-box; }
.wm6-audit-pair { margin: 0 0 8px; }.wm6-audit summary { cursor: pointer; color: #3889af; }.wm6-audit p { overflow-wrap: anywhere; }.wm6-audit-table { overflow: auto; max-width: 100%; }.wm6-audit table { border-collapse: collapse; width: 100%; text-align: left; font-size: 10px; }.wm6-audit th, .wm6-audit td { border-bottom: 1px solid #b9ccd8; padding: 6px; white-space: nowrap; }
</style>
