import type { Region, SceneObject, Size } from './types'

/** Card width as a fraction of board width, and height as a fraction of board height (16:9 board). */
export const SIZE_W: Record<Size, number> = { small: 0.07, medium: 0.09, large: 0.13 }
export const sizeH = (size: Size) => SIZE_W[size] * 1.15 * (16 / 9)

const ANCHORS: Record<Region, [number, number]> = {
  left: [0.14, 0.46],
  right: [0.86, 0.46],
  top: [0.5, 0.26],
  bottom: [0.5, 0.68],
  center: [0.5, 0.46],
  'top-left': [0.14, 0.26],
  'top-right': [0.86, 0.26],
  'bottom-left': [0.14, 0.68],
  'bottom-right': [0.86, 0.68],
}

/** Card centres stay inside this box, clear of the title bar, caption bar and camera view. */
const X_MIN = 0.06, X_MAX = 0.94, Y_MIN = 0.25, Y_MAX = 0.68
const STEP_X = 0.105, STEP_Y = 0.21

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function onBoard(x: number, y: number): [number, number] {
  return [clamp(x, X_MIN, X_MAX), clamp(y, Y_MIN, Y_MAX)]
}

export function anchor(region: Region): [number, number] {
  return ANCHORS[region]
}

/** Grid positions for n items centred on an anchor, kept on the board. */
export function cluster(n: number, [ax, ay]: [number, number]): [number, number][] {
  const rows = Math.min(Math.ceil(Math.sqrt(n)), 3)
  const cols = Math.ceil(n / rows)
  // Big clusters squeeze together (and overlap) rather than leaving the board.
  const stepX = cols > 1 ? Math.min(STEP_X, (X_MAX - X_MIN) / (cols - 1)) : STEP_X
  const stepY = rows > 1 ? Math.min(STEP_Y, (Y_MAX - Y_MIN) / (rows - 1)) : STEP_Y
  const w = (cols - 1) * stepX, h = (rows - 1) * stepY
  const cx = clamp(ax, X_MIN + w / 2, X_MAX - w / 2)
  const cy = clamp(ay, Y_MIN + h / 2, Y_MAX - h / 2)
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), c = i % cols
    const inRow = r === rows - 1 ? n - r * cols : cols
    const rowW = (inRow - 1) * stepX
    return [cx - rowW / 2 + c * stepX, cy - h / 2 + r * stepY]
  })
}

/** The candidate spot furthest from every existing object. */
export function freeSpot(objects: SceneObject[]): [number, number] {
  let best: [number, number] = [0.5, 0.46], bestD = -1
  for (let gx = 0; gx < 7; gx++) {
    for (let gy = 0; gy < 4; gy++) {
      const x = X_MIN + 0.03 + gx * ((X_MAX - X_MIN - 0.06) / 6)
      const y = Y_MIN + 0.03 + gy * ((Y_MAX - Y_MIN - 0.06) / 3)
      const d = Math.min(...objects.map(o => Math.hypot((o.x - x) * 1.6, o.y - y)), 9)
      if (d > bestD) { bestD = d; best = [x, y] }
    }
  }
  return best
}

/** Push objects not in `fixed` away from any overlap, so moved cards don't land on top of others. */
export function relax(objects: SceneObject[], fixed: Set<string>): SceneObject[] {
  const out = objects.map(o => ({ ...o }))
  for (let iter = 0; iter < 30; iter++) {
    let moved = false
    for (const a of out) {
      if (fixed.has(a.id)) continue
      for (const b of out) {
        if (a === b) continue
        const minX = (SIZE_W[a.size] + SIZE_W[b.size]) / 2 + 0.02
        const minY = (sizeH(a.size) + sizeH(b.size)) / 2 + 0.035
        const dx = a.x - b.x, dy = a.y - b.y
        if (Math.abs(dx) < minX && Math.abs(dy) < minY) {
          // Move along whichever axis needs the smaller push.
          const px = minX - Math.abs(dx), py = minY - Math.abs(dy)
          if (px / minX < py / minY) a.x += (dx >= 0 ? 1 : -1) * px * (fixed.has(b.id) ? 1 : 0.5)
          else a.y += (dy >= 0 ? 1 : -1) * py * (fixed.has(b.id) ? 1 : 0.5)
          a.x = clamp(a.x, X_MIN, X_MAX); a.y = clamp(a.y, Y_MIN, Y_MAX)
          moved = true
        }
      }
    }
    if (!moved) break
  }
  return out
}

export function arrangeAll(n: number, layout: 'grid' | 'row' | 'circle'): [number, number][] {
  if (layout === 'row') {
    return Array.from({ length: n }, (_, i) => [X_MIN + 0.02 + (i + 0.5) * ((X_MAX - X_MIN - 0.04) / n), 0.46])
  }
  if (layout === 'circle') {
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2
      return [0.5 + Math.cos(a) * 0.3, 0.465 + Math.sin(a) * 0.215]
    })
  }
  const cols = Math.ceil(Math.sqrt(n * 2))
  const rows = Math.ceil(n / cols)
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), c = i % cols
    return [
      X_MIN + 0.02 + (c + 0.5) * ((X_MAX - X_MIN - 0.04) / cols),
      rows === 1 ? (Y_MIN + Y_MAX) / 2 : Y_MIN + r * ((Y_MAX - Y_MIN) / (rows - 1)),
    ]
  })
}
