import { useEffect, useRef } from 'react'

/**
 * 监听鼠标侧键（XButton1，button === 3）触发返回
 * @param {() => void} onBack 返回回调
 */
export function useMouseBackButton(onBack) {
  const onBackRef = useRef(onBack)
  useEffect(() => {
    onBackRef.current = onBack
  }, [onBack])

  useEffect(() => {
    const handleMouseUp = (e) => {
      if (e.button === 3) {
        e.preventDefault()
        onBackRef.current()
      }
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [])
}
