import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const clobProxy = {
  '/clob-api': {
    target: 'https://clob.polymarket.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/clob-api/, ''),
    headers: { 'User-Agent': 'polymarket-rewards-monitor/1.0' },
  },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy: clobProxy },
  preview: { proxy: clobProxy },
})
