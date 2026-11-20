import { describe, expect, it } from 'vitest'
import type { Landmark } from '../input/people'
import { readFixes } from './fixes'
import { FULL, Zoom, reachBox, unseenWrist, unzoom } from './zoom'
import { Score } from './score'
import type { Hand } from './body'

/** A body with shoulders `width` apart (share of frame width) centred on (cx, cy), and optionally one wrist. */
function body(cx: number, cy: number, width: number, wrist?: { x: number; y: number }, visibility = 1): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  lm[11] = { x: cx + width / 2, y: cy, visibility }
  lm[12] = { x: cx - width / 2, y: cy, visibility }
  if (wrist) lm[15] = { ...wrist, visibility: 1 }
  return lm
}
const ASPECT = 16 / 9

describe('reachBox', () => {
  it('covers an arm’s reach to each side and above a far-off person, and less below', () => {
    const b = reachBox([body(0.5, 0.5, 0.08)], ASPECT)!
    expect(b.x).toBeCloseTo(0.5 - 3.1 * 0.08)
    expect(b.w).toBeCloseTo(2 * 3.1 * 0.08)
    const s = 0.08 * ASPECT // shoulder width in frame heights
    expect(b.y).toBeCloseTo(0.5 - 3.1 * s)
    expect(b.y + b.h).toBeCloseTo(0.5 + 2.2 * s)
  })

  it('stretches to a wrist held outside that reach, and stays inside the frame', () => {
    const b = reachBox([body(0.3, 0.5, 0.08, { x: 0.75, y: 0.2 })], ASPECT)!
    expect(b.x + b.w).toBeCloseTo(0.75 + 0.08)
    const near = reachBox([body(0.5, 0.5, 0.4)], ASPECT)!
    expect(near).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('takes in everyone, and ignores a body whose shoulders the pose is unsure of', () => {
    const two = reachBox([body(0.25, 0.5, 0.06), body(0.75, 0.5, 0.06)], ASPECT)!
    expect(two.x).toBeCloseTo(0.25 - 3.1 * 0.06)
    expect(two.x + two.w).toBeCloseTo(0.75 + 3.1 * 0.06)
    expect(reachBox([body(0.5, 0.5, 0.08, undefined, 0.2)], ASPECT)).toBeUndefined()
    expect(reachBox([], ASPECT)).toBeUndefined()
  })
})

describe('Zoom', () => {
  const far = [body(0.5, 0.5, 0.08)]

  it('looks at the whole frame for someone close, and zooms in on someone far once they have stayed far', () => {
    const z = new Zoom()
    expect(z.update([body(0.5, 0.5, 0.4)], ASPECT, 0)).toBe(FULL)
    expect(z.update(far, ASPECT, 100)).toBe(FULL)
    expect(z.update(far, ASPECT, 900)).toBe(FULL)
    const box = z.update(far, ASPECT, 1200)
    expect(box.w).toBeLessThan(0.7)
    expect(box.x).toBeCloseTo(0.5 - 3.1 * 0.08 - 0.06)
  })

  it('holds the box still while the person moves inside it, and moves it at once when they leave it', () => {
    const z = new Zoom()
    z.update(far, ASPECT, 0)
    const box = z.update(far, ASPECT, 1100)
    expect(z.update([body(0.52, 0.51, 0.08)], ASPECT, 1200)).toBe(box)
    const moved = z.update([body(0.7, 0.5, 0.08)], ASPECT, 1300)
    expect(moved).not.toBe(box)
    expect(moved.x + moved.w).toBeGreaterThan(0.7 + 3.1 * 0.08)
  })

  it('keeps the box through a short gap in the pose, then goes back to the whole frame', () => {
    const z = new Zoom()
    z.update(far, ASPECT, 0)
    const box = z.update(far, ASPECT, 1100)
    expect(z.update([], ASPECT, 1400)).toBe(box)
    expect(z.update([], ASPECT, 1700)).toBe(FULL)
  })

  it('maps a point found in the box back onto the whole frame', () => {
    expect(unzoom({ x: 0.5, y: 0.5, z: 3 }, { x: 0.2, y: 0.1, w: 0.4, h: 0.6 })).toEqual({ x: 0.4, y: 0.4, z: 3 })
    const p = { x: 0.3, y: 0.3 }
    expect(unzoom(p, FULL)).toBe(p)
  })
})

describe('readFixes', () => {
  it('has every fix on unless the address switches it off', () => {
    expect(readFixes('')).toEqual({ steady: true, loose: true, zoom: true })
    expect(readFixes('?off=zoom, steady')).toEqual({ steady: false, loose: true, zoom: false })
    expect(readFixes('?off=all')).toEqual({ steady: false, loose: false, zoom: false })
  })
})

describe('Score', () => {
  const hand = (id: number, raw: Hand['raw'], gesture = raw): Hand =>
    ({ id, x: 0, y: 0, tipX: 0, tipY: 0, vx: 0, vy: 0, gesture, gestureSince: 0, score: 1, landmarks: [], raw, label: '', fingers: [] })

  it('counts lost hands, reading changes and the short readings among them', () => {
    const s = new Score()
    s.frame(0, 1, [hand(1, 'palm')])
    s.frame(33, 1, [hand(1, 'none', 'palm')]) // palm lasted 33 ms: short
    s.frame(66, 1, [hand(1, 'palm')]) // none lasted 33 ms: short
    s.frame(400, 2, [hand(1, 'fist'), hand(2, 'palm')]) // palm lasted 334 ms
    s.frame(433, 0, [hand(2, 'palm')]) // hand 1 gone
    s.frame(466, 0, [])
    expect(s.result()).toEqual({ frames: 6, framesWithRawHand: 4, handFrames: 6, lost: 2, readingChanges: 3, shortReadings: 2, gestureChanges: 1 })
  })
})


describe('a second look for a hand the body pose knows about', () => {
  const A = 16 / 9
  const at = (x: number, y: number) => ({ landmarks: [{ x, y }] })

  it('takes in the patch around a wrist that has no hand found on it', () => {
    const patch = unseenWrist([body(0.5, 0.5, 0.2, { x: 0.5, y: 0.35 })], [], A, 0)!
    expect(patch.x).toBeLessThan(0.5)
    expect(patch.x + patch.w).toBeGreaterThan(0.5)
    expect(patch.y).toBeLessThan(0.35)
    expect(patch.y + patch.h).toBeGreaterThan(0.35)
    expect(patch.w * A).toBeCloseTo(patch.h) // square in the picture
    expect(patch.h).toBeLessThan(1)
  })

  it('leaves alone a wrist whose hand was found, one the pose is unsure of, and one off the picture', () => {
    expect(unseenWrist([body(0.5, 0.5, 0.2, { x: 0.5, y: 0.35 })], [at(0.52, 0.33)], A, 0)).toBeUndefined()
    expect(unseenWrist([body(0.5, 0.5, 0.2, { x: 0.5, y: 0.35 }, 0.2)], [], A, 0)).toBeUndefined()
    expect(unseenWrist([body(0.5, 0.5, 0.2, { x: 0.5, y: 1.05 })], [], A, 0)).toBeUndefined()
    expect(unseenWrist([], [], A, 0)).toBeUndefined()
  })

  it('takes several unseen wrists in turn, and stays inside the picture', () => {
    const two = [body(0.3, 0.5, 0.2, { x: 0.02, y: 0.1 }), body(0.7, 0.5, 0.2, { x: 0.7, y: 0.4 })]
    const first = unseenWrist(two, [], A, 0)!, second = unseenWrist(two, [], A, 1)!
    expect(first).not.toEqual(second)
    expect(unseenWrist(two, [], A, 2)).toEqual(first)
    // The one a hand was just found in is looked at again, whoever's turn it is.
    expect(unseenWrist(two, [], A, 0, second)).toEqual(second)
    expect(unseenWrist(two, [], A, 1, first)).toEqual(first)
    for (const p of [first, second]) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(1.0001)
      expect(p.y + p.h).toBeLessThanOrEqual(1.0001)
    }
  })
})
