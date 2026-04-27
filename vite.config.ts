import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import polymarketApiPlugin from './collector/vite-plugin'

const PAPER_PORT = process.env.PAPER_PORT ?? '7802'

const clobProxy = {
  '/clob-api': {
    target: 'https://clob.polymarket.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/clob-api/, ''),
    headers: { 'User-Agent': 'polymarket-rewards-monitor/1.0' },
  },
  '/paper-api': {
    target: `http://127.0.0.1:${PAPER_PORT}`,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/paper-api/, ''),
  },
}

export default defineConfig({
  plugins: [react(), polymarketApiPlugin()],
  server: { proxy: clobProxy },
  preview: { proxy: clobProxy },
  optimizeDeps: { exclude: ['better-sqlite3'] },
})
