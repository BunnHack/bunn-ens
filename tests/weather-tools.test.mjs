import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
globalThis.fetch = async () => new Response('Unavailable in UI fixture', { status: 503 })
const { createApp, nextTick } = await import('vue')
const { default: App } = await import(await compileFile('src/App.vue'))
const { weatherTools } = await import(await compileFile('src/data/weather-tools.ts'))
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 40)); await nextTick() }
const navigate = async hash => { window.location.hash = hash; await settle() }
const app = createApp(App)
app.mount('#app')

try {
  await test('Weather Tools replaces Aircraft Recon with an internal seven-card reference interface', async () => {
    const nav = [...document.querySelectorAll('.main-navigation a')]
    assert.equal(nav.length, 6)
    assert.equal(nav[1].textContent, 'Weather Tools')
    assert.equal(nav[1].getAttribute('href'), '#weather-tools')
    assert.equal(nav[1].getAttribute('target'), null)
    assert.ok(!nav.some(link => /Aircraft|Recon|aircon/i.test(link.textContent)))
    await navigate('#weather-tools')
    assert.equal(document.querySelector('#main-content').style.display, 'none')
    assert.equal(nav[1].getAttribute('aria-current'), 'page')
    assert.equal(nav[0].getAttribute('aria-current'), null)
    assert.equal(document.querySelectorAll('.tool-card').length, 7)
    assert.deepEqual([...document.querySelectorAll('.tool-card h2')].map(h => h.textContent), ['GIS系集預報', '洋區系集預報', '颱風攻擊機率', '中遠期襲擊潛勢', 'AIFS 風雨預報', '華南氣象愛好者', '廣東省天氣實況'])
    assert.equal(document.querySelectorAll('.tool-category').length, 7)
    assert.equal(document.querySelectorAll('.tool-more').length, 7)
    assert.match(document.querySelector('.tools-notice').textContent, /非即時/)
    assert.equal(document.activeElement, document.querySelector('#weather-tools h1'))
  })

  await test('Every details button has an internal detail view with honest data status and usable links', async () => {
    for (const tool of weatherTools) {
      await navigate(`#weather-tools/${tool.id}`)
      if (tool.id === 'extended') {
        assert.equal(document.querySelector('.extended-potential h1').textContent, '中遠期襲擊潛勢')
        assert.ok(document.querySelector('[aria-label="Potential start hour"]'))
        assert.equal(document.querySelector('.basin-workspace-tabs [aria-current="page"]').getAttribute('href'), '#weather-tools/extended')
        assert.match(document.querySelector('.ep-method').textContent, /非官方襲擊／登陸／損害率/)
        continue
      }
      if (tool.id === 'basin') {
        assert.ok(document.querySelector('.basin-layout'))
        assert.equal(document.querySelector('.basin-top h1').textContent, '洋區系集預報')
        assert.equal(document.querySelector('.basin-reference'), null)
        assert.match(document.querySelector('.basin-model-list .active').textContent, /WN3C/)
        assert.ok([...document.querySelectorAll('.basin-sidebar summary')].some(el => el.textContent.includes('台風潛勢預報')))
        assert.equal(document.querySelector('.basin-top a').getAttribute('href'), '#weather-tools')
        continue
      }
      assert.equal(document.querySelector('.tool-detail h2').textContent, tool.title)
      assert.equal(document.querySelector('.tool-detail-copy p').textContent, tool.detail)
      assert.equal(document.querySelector('.tool-detail img').getAttribute('src'), tool.image)
      assert.match(document.querySelector('figcaption').textContent, /非即時/)
      assert.equal(document.querySelector('.tools-back').getAttribute('href'), '#weather-tools')
      const links = [...document.querySelectorAll('.tool-resource-links a')]
      assert.ok(links.length > 0)
      for (const link of links) {
        if (link.getAttribute('href').startsWith('https:')) {
          assert.equal(link.target, '_blank')
          assert.match(link.rel, /noopener/)
        } else assert.ok(['#models-title', '#weather-tools/typhoon'].includes(link.getAttribute('href')))
      }
    }
    await navigate('#weather-tools')
    assert.equal(document.querySelectorAll('.tool-card').length, 7)
  })

  await test('Unknown tool routes recover and returning to storms preserves model panels', async () => {
    const originalPanel = document.querySelector('.forecast-grid')
    await navigate('#weather-tools/unknown')
    assert.match(document.querySelector('.tools-page [role="status"]').textContent, /找不到此工具/)
    assert.equal(document.querySelectorAll('.tool-card').length, 7)
    await navigate('#models-title')
    assert.equal(document.querySelector('#weather-tools').closest('.tools-surface').style.display, 'none')
    assert.equal(document.querySelector('#main-content').style.display, '')
    assert.equal(document.querySelector('.forecast-grid'), originalPanel)
    assert.equal(document.querySelector('.main-navigation a').getAttribute('aria-current'), 'page')
  })

  await test('Reference thumbnails exist locally as WebP, and responsive layout has 3/2/1 columns', async () => {
    for (const tool of weatherTools) {
      const bytes = await readFile(`public${tool.image}`)
      assert.equal(bytes.subarray(0, 4).toString(), 'RIFF')
      assert.equal(bytes.subarray(8, 12).toString(), 'WEBP')
    }
    const source = await readFile('src/components/WeatherTools.vue', 'utf8')
    assert.match(source, /grid-template-columns: repeat\(3,/)
    assert.match(source, /max-width: 800px[\s\S]+grid-template-columns: repeat\(2,/)
    assert.match(source, /max-width: 520px[\s\S]+grid-template-columns: minmax\(0, 1fr\)/)
  })
} finally {
  app.unmount()
  await navigate('#weather-tools/aifs')
  const second = createApp(App)
  second.mount('#app')
  await test('Direct Weather Tools detail URLs work on a fresh page load', async () => {
    try {
      await settle()
      assert.equal(document.querySelector('.tool-detail h2').textContent, 'AIFS 風雨預報')
    } finally { second.unmount(); dom.window.close() }
  })
}
