import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    warmup: {
      // Vite 只为 node_modules/.vite/deps 做持久化缓存，项目自身源码的 transform
      // 结果只存在内存里，dev server 一重启就全丢。桌面端每次 `pnpm tauri dev`
      // 都是一次冷启动，首屏要串行转换整棵模块图，窗口先出来、页面后到，表现为长时间白屏。
      // 这里让 Vite 在服务就绪时立刻并发预热首屏入口，把这段时间提前到窗口显示之前。
      clientFiles: [
        './src/main.jsx',
        './src/App.jsx',
        './src/index.css',
        './src/components/layout/TabNavigation.jsx',
        './src/components/TitleBar.jsx',
        './src/components/WelcomeScreen.jsx',
        './src/contexts/AuthContext.jsx',
        './src/contexts/DownloadCenterProvider.jsx',
        './src/i18n/index.js',
      ],
    },
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