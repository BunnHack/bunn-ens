<script setup lang="ts">
import { computed } from 'vue'
import { weatherTools } from '../data/weather-tools'

const props = defineProps<{ toolId?: string }>()
const selected = computed(() => weatherTools.find(tool => tool.id === props.toolId))
</script>

<template>
  <div class="tools-surface" lang="zh-Hant">
    <main id="weather-tools" class="tools-page">
      <header class="tools-heading">
        <div><p class="tools-eyebrow">FORECASTS · OBSERVATIONS · COMMUNITY</p><h1 tabindex="-1">Weather Tools</h1><p>氣象工具與預報資源</p></div>
        <a class="tools-home" href="#main-content">返回風暴監測 <span aria-hidden="true">↗</span></a>
      </header>
      <p class="tools-notice">依參考畫面整理的工具入口。縮圖與日期均來自參考截圖，並非即時預報或更新時間；產品接入情況請見詳細頁面。</p>

      <article v-if="selected" class="tool-detail" :aria-labelledby="`tool-${selected.id}`">
        <a class="tools-back" href="#weather-tools">← 所有氣象工具</a>
        <div class="tool-detail-layout">
          <figure><img :src="selected.image" :alt="`${selected.title}參考截圖`" width="740" height="440" /><figcaption>參考畫面 · 非即時資料</figcaption></figure>
          <div class="tool-detail-copy">
            <span class="tool-detail-category">{{ selected.category }}</span>
            <h2 :id="`tool-${selected.id}`">{{ selected.title }}</h2>
            <p>{{ selected.detail }}</p>
            <div class="tool-resource-links"><a v-for="link in selected.links" :key="link.href" :href="link.href" :target="link.external ? '_blank' : undefined" :rel="link.external ? 'noopener noreferrer' : undefined">{{ link.label }} <span aria-hidden="true">{{ link.external ? '↗' : '→' }}</span><span v-if="link.external" class="tools-sr-only">（新分頁）</span></a></div>
          </div>
        </div>
      </article>
      <template v-else>
        <p v-if="toolId" class="tools-notice" role="status">找不到此工具，請從下方清單選擇。</p>
        <section class="tools-grid" aria-label="氣象工具清單">
          <article v-for="tool in weatherTools" :key="tool.id" class="tool-card" :aria-labelledby="`tool-${tool.id}`">
            <a class="tool-thumbnail" :href="`#weather-tools/${tool.id}`" :aria-label="`查看${tool.title}詳細頁面`">
              <img :src="tool.image" :alt="`${tool.title}參考畫面`" width="370" height="220" loading="lazy" />
              <span class="tool-category">{{ tool.category }}</span>
            </a>
            <div class="tool-card-content">
              <div class="tool-card-title"><h2 :id="`tool-${tool.id}`">{{ tool.title }}</h2><span class="tool-date" aria-label="參考截圖日期">{{ tool.date }}</span></div>
              <p>{{ tool.description }}</p>
              <a class="tool-more" :href="`#weather-tools/${tool.id}`" :aria-label="`${tool.title}詳細頁面`">詳細頁面 <span aria-hidden="true">→</span></a>
            </div>
          </article>
        </section>
      </template>
      <footer class="tools-footer"><span>Weather Tools · 氣象工具</span><span>AI 預報僅供參考，警報與實況請以官方氣象機構為準。</span></footer>
    </main>
  </div>
</template>

<style scoped>
.tools-surface { min-height: calc(100vh - 76px); background: #edf1f5; color: #526575; font-family: 'Roboto', 'Noto Sans TC', 'Microsoft JhengHei', sans-serif; }
.tools-page { max-width: 1248px; padding: 30px 22px 0; }
.tools-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
.tools-eyebrow { font-size: 10px; letter-spacing: 1.8px; color: #899aaf; margin: 0 0 8px; }
.tools-heading h1 { color: #415a70; font-size: 29px; letter-spacing: -.6px; font-weight: 500; }
.tools-heading p:last-child { font-size: 13px; color: #8496aa; margin: 8px 0 0; }
.tools-home, .tools-back { color: #439cd0; font-size: 13px; }
.tools-home span { margin-left: 6px; }
.tools-notice { color: #74869a; font-size: 12px; line-height: 1.8; margin: 0 0 24px; max-width: 900px; }
.tools-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 30px; }
.tool-card { display: flex; flex-direction: column; min-width: 0; border-radius: 21px; overflow: hidden; background: #fff; box-shadow: 0 15px 28px #30455917; transition: transform .18s, box-shadow .18s; }
.tool-card:hover { transform: translateY(-3px); box-shadow: 0 18px 34px #30455923; }
.tool-thumbnail { display: block; position: relative; aspect-ratio: 370 / 220; overflow: hidden; background: #dfe8ed; }
.tool-thumbnail img { display: block; width: 100%; height: 100%; object-fit: cover; }
.tool-category { position: absolute; bottom: 15px; left: 15px; padding: 8px 14px; border-radius: 22px; color: white; background: #46a4d4; font-size: 13px; line-height: 1.1; box-shadow: 0 1px 2px #1b6f941a; }
.tool-card-content { display: flex; flex-direction: column; flex: 1; padding: 25px 26px 26px; min-height: 208px; }
.tool-card-title { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.tool-card-title h2 { color: #4c6070; font-size: 21px; font-weight: 500; line-height: 1.5; }
.tool-date { color: #9aadc3; font-size: 13px; white-space: nowrap; }
.tool-card-content p { margin: 16px 0 22px; color: #8191a7; font-size: 14px; line-height: 1.8; }
.tool-more { display: inline-flex; align-items: center; align-self: flex-end; gap: 12px; margin-top: auto; padding: 9px 18px; border: 2px solid #39a4e5; border-radius: 25px; color: #3ca3df; font-size: 14px; font-weight: 500; transition: background .18s, color .18s; }
.tool-more:hover { color: #fff; background: #39a4e5; }
.tool-more span { font-size: 19px; line-height: 1; }
.tool-detail { background: white; border-radius: 21px; padding: 26px; box-shadow: 0 15px 28px #30455917; }
.tools-back { display: inline-block; margin-bottom: 24px; }
.tool-detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; }
.tool-detail figure { margin: 0; }
.tool-detail img { width: 100%; height: auto; border-radius: 14px; }
.tool-detail figcaption { color: #8c9daf; font-size: 12px; margin-top: 10px; }
.tool-detail-copy h2 { color: #415a70; font-size: 25px; margin: 14px 0; }
.tool-detail-copy p { font-size: 15px; line-height: 1.9; margin: 0 0 24px; }
.tool-detail-category { background: #e8f5fc; color: #3996c9; border-radius: 20px; font-size: 12px; padding: 7px 12px; display: inline-block; }
.tool-resource-links { display: flex; flex-wrap: wrap; gap: 12px; }
.tool-resource-links a { padding: 11px 16px; border-radius: 24px; background: #46a4d4; color: white; font-size: 13px; }
.tools-footer { border: 0; padding: 28px 0; font-size: 11px; color: #8c9bad; }
.tools-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1000px) { .tools-grid { gap: 22px; }.tool-card-content { padding: 20px; }.tool-card-title { flex-wrap: wrap; gap: 4px 12px; }.tool-card-title h2 { font-size: 20px; } }
@media (max-width: 800px) { .tools-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.tool-detail-layout { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .tools-page { padding: 24px 16px 0; }.tools-heading { align-items: flex-start; }.tools-heading h1 { font-size: 25px; }.tools-eyebrow { font-size: 8px; letter-spacing: .8px; }.tools-home { font-size: 11px; white-space: nowrap; }.tools-grid { grid-template-columns: minmax(0, 1fr); gap: 24px; }.tool-card-content { min-height: 200px; padding: 22px; }.tool-card-title h2 { font-size: 21px; }.tool-detail { padding: 20px; }.tools-footer { flex-direction: column; gap: 8px; } }
</style>
