import { useCallback, useState } from 'react'

// 复用 hook：管理「按楼层分组」的灯箱状态。
// 用法：const lb = useImageLightbox()；内容组件 onImageClick={lb.open}；渲染 <Lightbox src={lb.src} images={lb.images} onClose={lb.close} />
// 每个内容容器（正文/某条回复/某个引用块）内的全部图片自动构成一组，方向键仅在该组内循环。
export function useImageLightbox() {
  const [src, setSrc] = useState(null)
  const [images, setImages] = useState(null)
  const open = useCallback((s, allImages) => {
    setSrc(s)
    setImages(Array.isArray(allImages) && allImages.length > 1 ? allImages : null)
  }, [])
  const close = useCallback(() => {
    setSrc(null)
    setImages(null)
  }, [])
  return { src, images, open, close }
}
