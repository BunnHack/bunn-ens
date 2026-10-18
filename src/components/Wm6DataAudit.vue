<script setup lang="ts">
import { computed } from 'vue'
import type { TrackPoint } from '../data/wnc2'
import { windPressureAudit } from '../data/wm6-audit'
const props = defineProps<{ points: TrackPoint[]; forecastZero?: string }>()
const audit = computed(() => windPressureAudit(props.points))
const rows = computed(() => [
  { label: '最低气压点', point: audit.value.minimumPressure },
  { label: '最大风速点', point: audit.value.maximumWind },
].filter((row): row is { label: string; point: TrackPoint } => row.point !== null))
const wind = (value: number) => Number.isFinite(value) && value >= 0 ? value.toFixed(1) : '—'
</script>

<template>
  <section class="wm6-audit" aria-label="WM-6 原始风压数值核对">
    <p v-if="audit.minimumPressure" class="wm6-audit-pair">目前图中最低气压 <strong>{{ audit.minimumPressure.pressure!.toFixed(1) }} hPa</strong>，同点风速 <strong>{{ wind(audit.minimumPressure.wind) }} kt</strong>。</p>
    <details><summary>原始 kt / hPa 核对（同一成员、同一时刻）</summary>
      <p>保留供应商的 max_wind_kt 与 min_mslp_hpa 原值，未互换栏位、未乘单位系数，也不依气压推算风速。气压与风速没有固定对照；最低气压与最大风速也可能来自不同成员或时刻。以下仅为目前图中 0–312h 的资料，不代表全模式极值。</p>
      <p v-if="forecastZero">时效基准 forecast_zero：{{ forecastZero }}；+h 以此为准，不一定等于发布起报时间。</p>
      <div class="wm6-audit-table"><table><thead><tr><th>核对点</th><th>原始 ID</th><th>成员</th><th>时效</th><th>有效时间 UTC</th><th>kt</th><th>hPa</th></tr></thead><tbody><tr v-for="row in rows" :key="row.label"><td>{{ row.label }}</td><td>{{ row.point.trackId }}</td><td>{{ row.point.sample }}</td><td>+{{ row.point.leadHours }}h</td><td>{{ row.point.validTime }}</td><td>{{ wind(row.point.wind) }}</td><td>{{ row.point.pressure?.toFixed(1) ?? '—' }}</td></tr></tbody></table></div>
      <p>风速缺值 {{ audit.missingWind }} 点；气压缺值 {{ audit.missingPressure }} 点。低压与弱风的组合若与其他资料有明显落差，仍需供应商确认风场定义、取样与校准，不能只凭风压组合判定是单位错误。</p>
    </details>
  </section>
</template>

<style scoped>
.wm6-audit { width: 100%; max-width: 870px; font-size: 11px; line-height: 1.8; margin-top: 12px; border: 1px solid #b9ccd8; border-radius: 8px; padding: 12px; min-width: 0; box-sizing: border-box; }
.wm6-audit-pair { margin: 0 0 8px; }.wm6-audit summary { cursor: pointer; color: #3889af; }.wm6-audit p { overflow-wrap: anywhere; }.wm6-audit-table { overflow: auto; max-width: 100%; }.wm6-audit table { border-collapse: collapse; width: 100%; text-align: left; font-size: 10px; }.wm6-audit th, .wm6-audit td { border-bottom: 1px solid #b9ccd8; padding: 6px; white-space: nowrap; }
</style>
