import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: true,
    // 不做手动分包：maxSize 强拆 vendor chunk 会破坏 Fluent UI 等库的模块
    // 副作用执行顺序（curveDecelerateMid undefined 白屏），桌面端本地加载
    // 单文件也无性能问题，仅调高 chunk 大小告警阈值。
    chunkSizeWarningLimit: 2560,
  },
})