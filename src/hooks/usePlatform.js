import { useState, useEffect } from 'react'
import { platform as tauriPlatform } from '@tauri-apps/plugin-os'

/**
 * 平台检测 hook
 * - Tauri 环境：通过 @tauri-apps/plugin-os 获取真实平台（android / windows / macos / ios / linux）
 * - 纯 Web 环境（浏览器预览）：回退到 userAgent 检测移动端
 *
 * @returns {{ platform: string, isAndroid: boolean, isMobile: boolean, isTauri: boolean, ready: boolean }}
 */
export function usePlatform() {
  const [info, setInfo] = useState(() => detectWebFallback())

  useEffect(() => {
    let cancelled = false
    // 尝试获取 Tauri 平台
    const detect = async () => {
      try {
        // Tauri 2 plugin-os 在 WebView 中可用；调用失败说明不在 Tauri 环境
        const p = await tauriPlatform()
        if (!cancelled) {
          setInfo({
            platform: p,
            isAndroid: p === 'android',
            isMobile: p === 'android' || p === 'ios',
            isTauri: true,
            ready: true,
          })
        }
      } catch {
        // 非 Tauri 环境（浏览器 / Capacitor 等），保持 web fallback
        if (!cancelled) setInfo(detectWebFallback())
      }
    }
    detect()
    return () => { cancelled = true }
  }, [])

  return { ...info, ready: true }
}

function detectWebFallback() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
  return {
    platform: isMobileUA(ua) ? mobileKind(ua) : 'desktop',
    isAndroid: /android/i.test(ua),
    isMobile: isMobileUA(ua),
    isTauri: false,
    ready: true,
  }
}

export function isMobileUA(ua) {
  return /android|iphone|ipad|ipod/i.test(ua || '')
}

function mobileKind(ua) {
  return /android/i.test(ua) ? 'android' : 'ios'
}
