import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import polymarketApiPlugin from './collector/vite-plugin'

const clobProxy = {
  '/clob-api': {
    target: 'https://clob.polymarket.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/clob-api/, ''),
    headers: { 'User-Agent': 'polymarket-rewards-monitor/1.0' },
  },
}

export default defineConfig({
  plugins: [react(), polymarketApiPlugin()],
  server: { proxy: clobProxy },
  preview: { proxy: clobProxy },
  optimizeDeps: { exclude: ['better-sqlite3'] },
})
