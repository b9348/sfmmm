import { useState, useEffect, useCallback, useRef } from 'react'
import { getCurrentWindow, PhysicalSize, PhysicalPosition } from '@tauri-apps/api/window'

function debounce(fn, delay) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

async function getDb() {
  try {
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    return await Database.load('sqlite:config.db')
  } catch (e) {
    console.warn('[usePersistUI] DB not available:', e)
    return null
  }
}

async function readConfig(keys) {
  const db = await getDb()
  if (!db) return {}
  try {
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
    const rows = await db.select(
      `SELECT ` + "`key`" + `, value FROM config WHERE ` + "`key`" + ` IN (${placeholders})`,
      keys
    )
    const map = {}
    rows.forEach(r => { map[r.key] = r.value })
    return map
  } catch (e) {
    console.warn('[usePersistUI] readConfig error:', e)
    return {}
  }
}

async function writeConfig(key, value) {
  try {
    const db = await getDb()
    if (!db) return
    await db.execute(
      `INSERT OR REPLACE INTO config (id, ` + "`key`" + `, value) VALUES ((SELECT id FROM config WHERE ` + "`key`" + ` = $1), $1, $2)`,
      [key, value]
    )
  } catch (e) {
    console.warn('[usePersistUI] writeConfig error:', key, e)
  }
}

export function usePersistUI() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [windowReady, setWindowReady] = useState(false)
  const appWindow = useRef(null)

  // Load sidebar state from DB on mount
  useEffect(() => {
    (async () => {
      const cfg = await readConfig(['sidebar_collapsed'])
      if (cfg.sidebar_collapsed === 'true') {
        setSidebarCollapsed(true)
      }
    })()
  }, [])

  // Toggle sidebar and persist
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev
      writeConfig('sidebar_collapsed', next ? 'true' : 'false')
      return next
    })
  }, [])

  // Restore window size/position on mount, then listen for changes
  useEffect(() => {
    let unlistenResize, unlistenMove

    ;(async () => {
      try {
        appWindow.current = getCurrentWindow()

        const cfg = await readConfig(['window_x', 'window_y', 'window_width', 'window_height', 'window_maximized'])
        const w = parseInt(cfg.window_width)
        const h = parseInt(cfg.window_height)
        if (w > 100 && h > 100) {
          await appWindow.current.setSize(new PhysicalSize(w, h))
        }
        const x = parseInt(cfg.window_x)
        const y = parseInt(cfg.window_y)
        if (!isNaN(x) && !isNaN(y)) {
          await appWindow.current.setPosition(new PhysicalPosition(x, y))
        }
        if (cfg.window_maximized === 'true') {
          await appWindow.current.maximize()
        }

        // Debounced save: only write when user stops resizing/moving for 600ms
        const saveWindowState = debounce(async () => {
          const win = appWindow.current
          if (!win) return
          try {
            const maximized = await win.isMaximized()
            writeConfig('window_maximized', maximized ? 'true' : 'false')
            if (!maximized) {
              const size = await win.outerSize()
              writeConfig('window_width', String(size.width))
              writeConfig('window_height', String(size.height))
              const pos = await win.outerPosition()
              writeConfig('window_x', String(pos.x))
              writeConfig('window_y', String(pos.y))
            }
          } catch (e) {
            console.warn('[usePersistUI] saveWindowState error:', e)
          }
        }, 600)

        unlistenResize = await appWindow.current.onResized(() => { saveWindowState() })
        unlistenMove = await appWindow.current.onMoved(() => { saveWindowState() })
      } catch (e) {
        console.warn('[usePersistUI] window init error:', e)
      }
      setWindowReady(true)
    })()

    return () => {
      unlistenResize?.then?.(fn => fn())
      unlistenMove?.then?.(fn => fn())
    }
  }, [])

  return {
    sidebarCollapsed,
    toggleSidebar,
    setSidebarCollapsed,
    windowReady,
  }
}
