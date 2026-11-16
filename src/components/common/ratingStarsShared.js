/** 将任意数值取整到 0.5 档位（0.5 ~ 5.0） */
export function roundHalf(v) {
  const n = Math.round(Number(v) * 2) / 2
  if (!Number.isFinite(n)) return 0
  return Math.min(5, Math.max(0, n))
}
