<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { chartPng, serializeChart } from '../data/chart-image'
import { publishedPng } from '../data/published-png'
import { zhHans } from '../data/zh-hans'
const props = defineProps<{ filename: string; title?: string; png?: string }>()
let pngController:AbortController|undefined
const root = ref<HTMLElement | null>(null)
const viewport = ref<HTMLElement | null>(null)
const zoom = ref(1), enlarged = ref(false), exporting = ref(false), preview = ref(''), error = ref('')
let previousFocus: HTMLElement | null = null, previousOverflow = '', disposed = false
let drag: { x: number; y: number; left: number; top: number } | null = null
function svgText() {
  const svg = root.value?.querySelector('svg')
  if (!svg) throw new Error('圖表尚未載入。')
  return serializeChart(svg)
}
function download(href: string, extension: string, filename = props.filename) {
  const anchor = document.createElement('a'); anchor.href = href; anchor.download = `${filename}.${extension}`
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
}
function saveSvg() {
  error.value = ''
  try {
    const url = URL.createObjectURL(new Blob([svgText()], { type: 'image/svg+xml;charset=utf-8' }))
    try { download(url, 'svg') } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '無法儲存 SVG。' }
}
async function savePng() {
  if (exporting.value) return
  exporting.value = true; error.value = ''
  const name = props.filename, original=props.png
  pngController=new AbortController()
  try {
    const png = original ? URL.createObjectURL(await publishedPng(original,pngController.signal)) : await chartPng(svgText())
    if (!disposed && name === props.filename && original===props.png) { if(preview.value.startsWith('blob:'))URL.revokeObjectURL(preview.value);preview.value = png; download(png, 'png', name) }
    else if(original)URL.revokeObjectURL(png)
  } catch (cause) { if (!disposed && name === props.filename && original===props.png) error.value = `${cause instanceof Error ? cause.message : 'PNG导出失败'}${original?'；不保存其他图代替。':'；可改用下载SVG。'}` }
  finally { if (!disposed) exporting.value = false }
}
async function toggleEnlarged() {
  if (!enlarged.value) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'
    enlarged.value = true; await nextTick(); root.value?.querySelector<HTMLButtonElement>('.chart-expand')?.focus()
  } else { enlarged.value = false; document.body.style.overflow = previousOverflow; previousFocus?.focus() }
}
function keydown(event: KeyboardEvent) {
  if (!enlarged.value) return
  if (event.key === 'Escape') { event.stopPropagation(); toggleEnlarged() }
  if (event.key === 'Tab') {
    const nodes = [...root.value!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select')]
    const first = nodes[0], last = nodes[nodes.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
function startDrag(event: PointerEvent) {
  if (zoom.value <= 1 || event.pointerType === 'touch' || !viewport.value) return
  drag = { x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop }
  viewport.value.setPointerCapture?.(event.pointerId); event.preventDefault()
}
function moveDrag(event: PointerEvent) {
  if (!drag || !viewport.value) return
  viewport.value.scrollLeft = drag.left + drag.x - event.clientX; viewport.value.scrollTop = drag.top + drag.y - event.clientY
}
function resetZoom() { zoom.value = 1; if (viewport.value) { viewport.value.scrollLeft = 0; viewport.value.scrollTop = 0 } }
watch(preview,(_,old)=>{if(old.startsWith('blob:'))URL.revokeObjectURL(old)})
watch([() => props.filename,()=>props.png], () => { pngController?.abort();preview.value = ''; error.value = ''; resetZoom() })
onBeforeUnmount(() => { disposed = true; pngController?.abort();if(preview.value.startsWith('blob:'))URL.revokeObjectURL(preview.value);if (enlarged.value) document.body.style.overflow = previousOverflow })
</script>

<template>
  <section ref="root" class="chart-frame" :class="{ 'chart-frame-enlarged': enlarged }" :role="enlarged ? 'dialog' : 'region'" :aria-modal="enlarged ? true : undefined" :aria-label="title || '预报图表'" @keydown="keydown">
    <div class="chart-actions"><button class="chart-expand" @click="toggleEnlarged">{{ enlarged ? '关闭大图' : '放大地图' }}</button><button aria-label="Zoom out chart" :disabled="zoom <= 1" @click="zoom = Math.max(1, zoom - .25)">−</button><span>{{ Math.round(zoom * 100) }}%</span><button aria-label="Zoom in chart" :disabled="zoom >= 4" @click="zoom = Math.min(4, zoom + .25)">＋</button><button @click="resetZoom">重设</button><button v-if="!png" class="chart-save-svg" @click="saveSvg">下载 SVG</button><button class="chart-save-png" :disabled="exporting" @click="savePng">{{ exporting ? '处理中…' : '下载 PNG' }}</button></div>
    <p class="chart-help">可缩放至 400%；放大后可拖曳或触控滚动。下载保留完整图表与原始长宽比例。</p>
    <div ref="viewport" class="chart-viewport" :class="{ 'chart-draggable': zoom > 1 }" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="drag = null" @pointercancel="drag = null" @lostpointercapture="drag = null"><div class="chart-canvas" :style="{ width: `${zoom * 100}%` }"><slot /></div></div>
    <p v-if="error" class="chart-export-error" role="alert">{{ zhHans(error) }}</p>
    <div v-if="preview" class="chart-png-preview"><p>手机可长按图片储存。<a :href="preview" :download="`${filename}.png`">下载图片</a> <button @click="preview = ''">关闭预览</button></p><img :src="preview" :alt="`${title || '预报图表'} PNG，可长按储存`" /></div>
  </section>
</template>

<style scoped>
.chart-frame { width: 100%; min-width: 0; }.chart-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin: 0 0 8px; }.chart-actions button, .chart-png-preview button { padding: 9px 12px; border: 1px solid #80b8ca; border-radius: 18px; color: #217d9b; background: #f1fafc; font-size: 12px; }.chart-actions button:disabled { opacity: .45; }.chart-actions span, .chart-help { font-size: 11px; }.chart-help { color: #788c9d; margin: 6px 0 12px; }.chart-viewport { overflow: auto; max-height: 84vh; overscroll-behavior: contain; }.chart-canvas { min-width: 100%; }.chart-canvas :deep(svg) { display: block; width: 100%; max-width: none; height: auto; }.chart-draggable { cursor: grab; }.chart-draggable:active { cursor: grabbing; }.chart-frame-enlarged { position: fixed; inset: 12px; z-index: 1500; width: auto; padding: 18px; border-radius: 12px; background: white; color: #333; box-shadow: 0 0 0 30px #162537bd; overflow: auto; }.chart-frame-enlarged .chart-viewport { max-height: calc(100dvh - 150px); }.chart-export-error { color: #bd3c37; font-size: 12px; }.chart-png-preview { font-size: 12px; margin-top: 14px; }.chart-png-preview img { width: 100%; height: auto; }.chart-png-preview a { color: #217d9b; }
@media (max-width: 600px) { .chart-frame-enlarged { inset: 4px; padding: 10px; }.chart-actions { gap: 5px; }.chart-actions button { padding: 8px; font-size: 11px; } }
</style>
