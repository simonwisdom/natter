/**
 * Where in the camera picture to look for hands. The hand model first finds palms in a small
 * copy of whatever picture it is given, so a hand a few steps from the camera is only a few
 * dots wide and gets missed. Handing it just the part of the picture the people can reach
 * makes their hands that much bigger. Pure and clock-driven.
 */
import type { Landmark } from '../input/people'

/** A part of the camera frame, as fractions of its width and height. */
export interface Box { x: number; y: number; w: number; h: number }
export const FULL: Box = { x: 0, y: 0, w: 1, h: 1 }

const seen = (l?: Landmark) => !!l && (l.visibility ?? 1) >= 0.5
// In shoulder widths, from the middle of the shoulders: an arm is a little over two, plus the hand.
const REACH_SIDE = 3.1
const REACH_UP = 3.1
const REACH_DOWN = 2.2 // to about the waist; hands lower than that are resting
const AROUND_WRIST = 1 // a wrist the pose can see always gets this much room around it

/** The part of the frame these people's hands can reach, or nothing when no shoulders are in view. `aspect` is frame width over height. */
export function reachBox(bodies: Landmark[][], aspect: number): Box | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const lm of bodies) {
    const l = lm[11], r = lm[12]
    if (!seen(l) || !seen(r)) continue
    const s = Math.hypot((l.x - r.x) * aspect, l.y - r.y) // shoulder width, in frame heights
    if (s < 0.02) continue
    const cx = (l.x + r.x) / 2, cy = (l.y + r.y) / 2
    const grow = (x: number, y: number, side: number, up: number, down: number) => {
      x0 = Math.min(x0, x - side * s / aspect); x1 = Math.max(x1, x + side * s / aspect)
      y0 = Math.min(y0, y - up * s); y1 = Math.max(y1, y + down * s)
    }
    grow(cx, cy, REACH_SIDE, REACH_UP, REACH_DOWN)
    for (const i of [15, 16]) if (seen(lm[i])) grow(lm[i].x, lm[i].y, AROUND_WRIST, AROUND_WRIST, AROUND_WRIST)
  }
  if (x0 === Infinity) return undefined
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const WORTH_IT = 0.8 // a box this much of the frame's width and height isn't worth cutting out
const PAD = 0.06 // room left around the box, so small movements don't move it
const LOST_MS = 500 // with nobody in view this long, look at the whole frame again
const SHRINK_MS = 1000 // the box only tightens once the people have needed less for this long
const SHRINK_AT = 0.6 // ... and less means under this share of its area

const inside = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

/**
 * Holds the box still while the people stay inside it. The hand model follows each hand from
 * frame to frame, and loses its place whenever the picture it is given shifts.
 */
export class Zoom {
  box: Box = FULL
  private lastBody = -Infinity
  private smallSince?: number

  update(bodies: Landmark[][], aspect: number, t: number): Box {
    const reach = reachBox(bodies, aspect)
    if (!reach) {
      if (t - this.lastBody >= LOST_MS) this.box = FULL
      return this.box
    }
    this.lastBody = t
    const want: Box = reach.w >= WORTH_IT && reach.h >= WORTH_IT ? FULL : {
      x: Math.max(0, reach.x - PAD), y: Math.max(0, reach.y - PAD),
      w: Math.min(1, reach.x + reach.w + PAD) - Math.max(0, reach.x - PAD),
      h: Math.min(1, reach.y + reach.h + PAD) - Math.max(0, reach.y - PAD),
    }
    if (!inside(reach, this.box)) {
      this.box = want
      this.smallSince = undefined
    } else if (want.w * want.h < this.box.w * this.box.h * SHRINK_AT) {
      this.smallSince ??= t
      if (t - this.smallSince >= SHRINK_MS) { this.box = want; this.smallSince = undefined }
    } else this.smallSince = undefined
    return this.box
  }
}

/** A point found in the cut-out picture, back in whole-frame coordinates. */
export function unzoom<P extends { x: number; y: number }>(p: P, box: Box): P {
  return box === FULL ? p : { ...p, x: box.x + p.x * box.w, y: box.y + p.y * box.h }
}

const NEAR_SIDE = 2.2 // shoulder widths: how much of the picture around a wrist the second look takes in
const ON_WRIST = 0.6 // shoulder widths: a hand found this close to a wrist is that wrist's hand

/**
 * A wrist the body pose can see that no found hand is on, and the square patch of the picture
 * around its hand. With several, the one the `last` look found a hand in comes first, and
 * otherwise `turn` picks which this time. Hands hanging below the elbow
 * at the bottom of the picture are at rest and not worth the look.
 */
export function unseenWrist(bodies: Landmark[][], hands: { landmarks: { x: number; y: number }[] }[], aspect: number, turn: number, last?: Box): Box | undefined {
  const patches: Box[] = []
  for (const lm of bodies) {
    if (!seen(lm[11]) || !seen(lm[12])) continue
    const s = Math.hypot((lm[11].x - lm[12].x) * aspect, lm[11].y - lm[12].y) // shoulder width, in frame heights
    if (s < 0.05) continue
    for (const [w, e] of [[15, 13], [16, 14]]) {
      const wrist = lm[w], elbow = lm[e]
      if (!seen(wrist) || wrist.x < 0 || wrist.x > 1 || wrist.y < 0 || wrist.y > 0.97) continue
      if (seen(elbow) && wrist.y > elbow.y + 0.05 && wrist.y > 0.8) continue
      if (hands.some(h => Math.hypot((h.landmarks[0].x - wrist.x) * aspect, h.landmarks[0].y - wrist.y) < ON_WRIST * s)) continue
      // The hand lies beyond the wrist, along the forearm.
      let cx = wrist.x, cy = wrist.y
      if (seen(elbow)) {
        const dx = (wrist.x - elbow.x) * aspect, dy = wrist.y - elbow.y, len = Math.hypot(dx, dy) || 1
        cx += dx / len * 0.35 * s / aspect; cy += dy / len * 0.35 * s
      }
      const h = Math.min(1, NEAR_SIDE * s), wd = Math.min(1, h / aspect)
      patches.push({ x: Math.min(1 - wd, Math.max(0, cx - wd / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w: wd, h })
    }
  }
  // A hand the last look found is followed: looked for in the same place again, so it is seen every frame, not one in a few.
  const mid = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  const same = last && patches.find(p => Math.hypot((mid(p).x - mid(last).x) * aspect, mid(p).y - mid(last).y) < last.h / 4)
  return same ?? (patches.length ? patches[turn % patches.length] : undefined)
}
