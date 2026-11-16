/**
 * 平台检测 hook
 *
 * APK 分支专用：手机端是「纯社区模式」，只保留 社区 / 通知 / 设置，
 * 本地模组、存档、导入导出、下载安装、订阅记录等桌面能力全部不暴露。
 *
 * 判定只看 UA：Android WebView（Tauri APK）的 UA 必带 "Android"，桌面
 * WebView2 带 "Windows NT"，因此不需要引入 @tauri-apps/plugin-os 这个
 * 原生依赖（少一个插件、少一条 capability 权限，APK 体积也小一点）。
 * UA 在进程生命周期内不变，所以这里同步算一次即可，不用 effect 异步探测。
 *
 * @returns {{ platform: string, isAndroid: boolean, isMobile: boolean, isTauri: boolean, ready: boolean }}
 */
export function usePlatform() {
  return detectPlatform()
}

export function detectPlatform() {
  if (typeof navigator === 'undefined') {
    return { platform: 'desktop', isAndroid: false, isMobile: false, isTauri: false, ready: true }
  }
  const ua = navigator.userAgent || ''
  const isAndroid = /android/i.test(ua)
  const isMobile = isMobileUA(ua)
  return {
    platform: isAndroid ? 'android' : isMobile ? 'ios' : 'desktop',
    isAndroid,
    isMobile,
    isTauri: typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__,
    ready: true,
  }
}

/** 是否移动端 UA（Android / iPhone / iPad / iPod） */
export function isMobileUA(ua) {
  return /android|iphone|ipad|ipod/i.test(ua || '')
}
