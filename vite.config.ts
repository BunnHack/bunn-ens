import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { wnc2Proxy } from './server/wnc2-proxy.ts'

const weatherNextProxy: Plugin = {
  name: 'weathernext-csv-proxy',
  configureServer(server) { server.middlewares.use(wnc2Proxy) },
  configurePreviewServer(server) { server.middlewares.use(wnc2Proxy) },
}

export default defineConfig({
  plugins: [vue(), weatherNextProxy],
})
