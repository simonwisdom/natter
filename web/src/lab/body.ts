/**
 * Body Lab signal processing: camera landmarks → steady, debounced hands in board coordinates.
 * Pure and clock-driven so it can be tested with synthetic frames.
 */
import type { Landmark } from '../input/people'

export interface Pt { x: number; y: number }
export type Gesture = 'fist' | 'palm' | 'thumbUp' | 'thumbDown' | 'point' | 'victory' | 'none'

/** One detected hand, in raw camera coordinates (0..1, not mirrored). */
export interface RawHand {
  landmarks: Pt[]
  gesture: Gesture
  /** The classifier's reading on its own, before our finger tests. When set (with `fingers`), the tracker reads the gesture itself, knowing what the hand was doing a frame ago. */
  base?: Gesture
  score: number
  /** The classifier's own name for the pose (for the session log). */
  label?: string
  /** How far each finger is extended, index to little finger (see fingerReach). */
  fingers?: number[]
}

export interface Pt3 { x: number; y: number; z: number }

/**
 * How far each finger (index, middle, ring, little) reaches from the wrist, as fingertip
 * distance over middle-knuckle distance: about 0.8-1.0 curled, 1.4-1.7 straight.
 * Uses 3D points so a finger aimed at the camera still counts.
 */
export function fingerReach(lm: Pt3[]): number[] {
  const d = (a: Pt3, b: Pt3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  return [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, pip]) => d(lm[tip], lm[0]) / Math.max(1e-6, d(lm[pip], lm[0])))
}

/**
 * Index finger out and clearly further out than the other three, in any direction. The
 * classifier's own "pointing up" only fires for a finger held upright.
 * Tuned on a recorded session: on a laptop camera a straight finger reads about 1.3-1.4 and
 * a curled one 0.6-0.9, and while pointing loosely the other fingers drift up to about 1.2.
 */
export const POINT_OUT = 1.2
export const POINT_LEAD = 0.1
/**
 * Every finger test is easier to stay in than to enter (`held`: the hand was already read this
 * way). In recorded sessions half of all readings lasted under 100 ms, and most of those sat
 * just the wrong side of a single cut-off: a point at 1.18, an open hand
 * with one finger at 1.16.
 */
const POINT_OUT_HELD = 1.1
const POINT_LEAD_HELD = 0.03
export function isPointing(fingers: number[], held = false): boolean {
  return fingers[0] >= (held ? POINT_OUT_HELD : POINT_OUT) && fingers[0] - Math.max(...fingers.slice(1)) >= (held ? POINT_LEAD_HELD : POINT_LEAD)
}

/** All four fingers straight: an open hand, even when the classifier isn't sure (it often reads a tilted open hand as nothing). */
export function isOpen(fingers: number[], held = false): boolean {
  return fingers.every(f => f >= (held ? 1.1 : 1.25))
}

/** Index and middle fingers out, clearly further than the ring and little fingers. */
export function isVictory(fingers: number[], held = false): boolean {
  const two = Math.min(fingers[0], fingers[1])
  return two >= (held ? POINT_OUT_HELD : POINT_OUT) && two - Math.max(fingers[2], fingers[3]) >= (held ? POINT_LEAD_HELD : POINT_LEAD)
}

/** A fist the classifier has stopped naming still counts while every finger stays curled. Only ever keeps a fist; the classifier starts one. */
const FIST_HELD = 1.05

/**
 * What a hand is doing: the classifier's word (`base`), corrected by our own finger tests,
 * which cover a finger aimed anywhere. Thumbs keep the classifier's word. `prev` is what the
 * same hand read as a frame ago; that reading is kept through a borderline frame.
 *
 * There is no pinch. It was read from the gap between thumb and fingertip, which the camera
 * judges badly unless the hand is square to it: in recorded sessions it did nothing two times
 * in three, came out of victory signs, and let go mid-drag. The fist does everything it did.
 */
export function readGesture(base: Gesture, fingers: number[], prev: Gesture = 'none'): Gesture {
  if (!fingers.length || base === 'thumbUp' || base === 'thumbDown') return base
  if (isPointing(fingers, prev === 'point')) return 'point'
  if (isVictory(fingers, prev === 'victory')) return 'victory'
  if (base !== 'none') return base
  if (isOpen(fingers, prev === 'palm')) return 'palm'
  if (prev === 'fist' && Math.max(...fingers) <= FIST_HELD) return 'fist'
  return 'none'
}

export interface Frame { t: number; bodies: Landmark[][]; hands: RawHand[] }

/**
 * Camera frame → board coordinates, mirrored. `margin` is how much of the frame's edge is
 * left off the board: more zooms the body in (small movements go further), less zooms it
 * out (more room to work, but the board's edge is nearer the edge of shot).
 */
export const DEFAULT_MARGIN = 0.06
export let margin = DEFAULT_MARGIN
export function setMargin(m: number) {
  margin = Math.min(0.2, Math.max(-0.5, m))
}
/** The outer part of the camera's view, where hands are cut off and tracked badly. */
export const CAMERA_EDGE = 0.06

/** How far in from each side of the board the hands can reach, as a board fraction (0 when the view is zoomed in enough). */
export function reachInset(): number {
  return Math.min(0.35, Math.max(0, (CAMERA_EDGE - margin) / (1 - 2 * margin)))
}

export function toBoard(p: Pt): Pt {
  return { x: (1 - p.x - margin) / (1 - 2 * margin), y: (p.y - margin) / (1 - 2 * margin) }
}

/** A tracked hand in board coordinates. */
export interface Hand {
  id: number
  x: number
  y: number
  /** What the hand aims with: the index fingertip. */
  tipX: number
  tipY: number
  /** Board widths/heights per second. */
  vx: number
  vy: number
  gesture: Gesture
  /** When the current gesture began. */
  gestureSince: number
  score: number
  landmarks: Pt[]
  /** This frame's undebounced reading, for the session log. */
  raw: Gesture
  label: string
  fingers: number[]
  /** Hanging by the side or in the lap, not held up to work (set from the body pose). Resting hands start nothing. */
  resting?: boolean
  /** With two people in shot: whose hand it is (0 on the left of the screen, 1 on the right). Set from the body pose. */
  person?: number
}

interface Slot extends Hand {
  pending?: Gesture
  pendingSince: number
  lastSeen: number
  firstSeen: number
  frames: number
  /** Finger reach, evened out over the last few frames. */
  steadyFingers?: number[]
}

const MATCH = 0.3 // a hand further than this from every known hand is a new one
// Keep a hand this long after it drops out of a frame. In recorded sessions about a fifth of
// dropouts were back within half a second, and a shorter wait dropped whatever the hand held.
const COAST_MS = 500
const SWITCH_MS = 80 // a new gesture must hold this long to count
const UNFIST_MS = 160 // letting go takes longer, so a fast drag doesn't drop the card
const UNPOINT_MS = 200 // a pointing finger wavers; don't drop the point for a flicker
// An opening fist passes through a pointing shape (the index finger uncurls first), so a point must hold longer to count.
const TO_POINT_MS = 160
// Recorded sessions showed one-frame phantom hands, often a second detection of the same hand.
const DUPLICATE = 0.1 // two detections this close are one hand
const CONFIRM_FRAMES = 3 // a new hand must be seen this many frames running before it counts
const COAST_AFTER_MS = 400 // only a hand that has been around this long is kept through a dropout

const STEADY = 0.6 // how much of each new finger measurement is taken; the rest is the running value

const palmCentre = (lm: Pt[]): Pt => {
  const idx = [0, 5, 9, 13, 17].filter(i => lm[i])
  const n = idx.length || 1
  return { x: idx.reduce((s, i) => s + lm[i].x, 0) / n, y: idx.reduce((s, i) => s + lm[i].y, 0) / n }
}

export class HandTracker {
  private slots: Slot[] = []
  private steady: boolean
  /** How long a hand the camera has stopped finding is kept where it was, in case it comes straight back. */
  private coastMs: number

  /** `steady` off reads each frame on its own, as before the flicker fix (for comparing replays). */
  constructor(steady = true, coastMs = COAST_MS) {
    this.steady = steady
    this.coastMs = coastMs
  }

  update(detected: RawHand[], t: number): Hand[] {
    // Drop a second detection of the same hand, keeping the more confident one.
    const centres = detected.map(h => toBoard(palmCentre(h.landmarks)))
    const raw = detected.filter((h, i) => !detected.some((o, j) => j !== i
      && Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y) < DUPLICATE
      && (o.score > h.score || (o.score === h.score && j < i))))
    // Pair detections with known hands as a whole: keep as many hands as possible, then move
    // them as little as possible. Pairing each detection with its nearest hand in turn lets two
    // hands swap identities when one moves next to where the other was.
    const points = raw.map(h => toBoard(palmCentre(h.landmarks)))
    let bestPairs: { s: Slot; d: number }[] = [], bestCount = -1, bestTotal = Infinity
    const assign = (i: number, used: Set<Slot>, pairs: ({ s: Slot; d: number } | undefined)[], total: number) => {
      if (i === points.length) {
        const count = pairs.filter(Boolean).length
        if (count > bestCount || (count === bestCount && total < bestTotal)) {
          bestCount = count
          bestTotal = total
          bestPairs = pairs.slice() as { s: Slot; d: number }[]
        }
        return
      }
      assign(i + 1, used, [...pairs, undefined], total) // a hand not seen before
      for (const s of this.slots) {
        const d = Math.hypot(s.x - points[i].x, s.y - points[i].y)
        if (used.has(s) || d >= MATCH) continue
        used.add(s)
        assign(i + 1, used, [...pairs, { s, d }], total + d)
        used.delete(s)
      }
    }
    assign(0, new Set(), [], 0)
    const matched = new Map(bestPairs.flatMap((pair, i) => (pair ? [[i, pair] as const] : [])))
    for (const [i, h] of raw.entries()) {
      const p = points[i]
      const landmarks = h.landmarks.map(toBoard)
      const match = matched.get(i)
      const best = match ? 0 : -1, bestD = match?.d ?? MATCH
      if (best < 0) {
        let id = 1
        while (this.slots.some(s => s.id === id)) id++
        this.slots.push({
          id, x: p.x, y: p.y, tipX: (landmarks[8] ?? p).x, tipY: (landmarks[8] ?? p).y, vx: 0, vy: 0, gesture: h.gesture, gestureSince: t,
          score: h.score, landmarks, pendingSince: t, lastSeen: t, firstSeen: t, frames: 1,
          raw: h.gesture, label: h.label ?? '', fingers: h.fingers ?? [],
        })
        continue
      }
      const s = match!.s
      // Read the gesture here, where the hand's last reading is known, from measurements evened
      // out over a few frames: a single noisy frame near a cut-off doesn't change the reading.
      let gesture = h.gesture
      if (this.steady && h.base !== undefined && h.fingers?.length) {
        const was = s.steadyFingers
        s.steadyFingers = h.fingers.map((f, k) => (was?.length === h.fingers!.length ? was[k] + (f - was[k]) * STEADY : f))
        gesture = readGesture(h.base, s.steadyFingers, s.raw)
      } else {
        s.steadyFingers = undefined
      }
      const dt = Math.max(1, t - s.lastSeen) / 1000
      // Smooth more when still (kills jitter), less when moving (keeps up with the hand).
      const a = Math.min(0.9, 0.35 + bestD * 12)
      const nx = s.x + (p.x - s.x) * a, ny = s.y + (p.y - s.y) * a
      s.vx += ((nx - s.x) / dt - s.vx) * 0.5
      s.vy += ((ny - s.y) / dt - s.vy) * 0.5
      s.x = nx; s.y = ny
      // The fingertip rides on the smoothed hand, so it is as steady as the hand is.
      const tip = landmarks[8] ?? p
      s.tipX = nx + (tip.x - p.x)
      s.tipY = ny + (tip.y - p.y)
      s.lastSeen = t
      s.frames++
      s.score = h.score
      s.landmarks = landmarks
      s.raw = gesture
      s.label = h.label ?? ''
      s.fingers = h.fingers ?? []
      if (gesture === s.gesture) s.pending = undefined
      else if (s.pending !== gesture) { s.pending = gesture; s.pendingSince = t }
      else if (t - s.pendingSince >= (s.gesture === 'fist' ? UNFIST_MS : s.gesture === 'point' || s.gesture === 'victory' ? UNPOINT_MS : gesture === 'point' ? TO_POINT_MS : SWITCH_MS)) {
        s.gesture = gesture
        s.gestureSince = t
        s.pending = undefined
      }
    }
    // An unconfirmed hand that misses a frame is gone at once; an established one coasts.
    this.slots = this.slots.filter(s => s.lastSeen === t || (s.lastSeen - s.firstSeen >= COAST_AFTER_MS && t - s.lastSeen <= this.coastMs))
    return this.slots.filter(s => s.frames >= CONFIRM_FRAMES)
      .map(({ pending: _p, pendingSince: _s, lastSeen: _l, firstSeen: _f, frames: _n, ...hand }) => hand)
  }
}
