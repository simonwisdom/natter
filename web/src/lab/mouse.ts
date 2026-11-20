/**
 * A stand-in hand driven by the mouse, so everything hands can do on the board can also be
 * done without the camera. It is handed to the board as one more hand, so it takes the same
 * paths as a real one. Pure and clock-driven.
 *
 *   drag a bubble                      fist: move, drop, merge, fling
 *   press and hold on empty space      fist: a new idea (say it), let go to place it
 *   right-drag (or Shift-drag)         point: pull a branch out of a bubble, or connect two
 *   Alt-press (or middle button)       victory: ask the LLM for two more ideas
 *   T / Backspace over a bubble        thumbs up / down: star / bin
 *   In Draw zones, drag draws, resizes and moves zones; press and hold a title to say its name.
 *   In delete mode, press and hold a bubble to bin it.
 */
import type { Gesture, Hand } from './body'

export const MOUSE_HAND = 99
const IDLE_MS = 2500 // the hand goes once the mouse has been still this long with nothing held
const THUMB_MS = 750 // a key press holds a thumb long enough to count
const STILL_MS = 80 // no movement for this long: the hand has stopped

export class MouseHand {
  private x = 0
  private y = 0
  private vx = 0
  private vy = 0
  private movedAt = -Infinity
  private held?: Gesture
  private thumbing?: { gesture: Gesture; until: number }
  private gesture: Gesture = 'palm'
  private since = 0
  /** Not yet shown to the board. A hand is first seen open, so a press is always a change the board notices. */
  private fresh = true

  move(x: number, y: number, t: number) {
    const dt = (t - this.movedAt) / 1000
    if (dt > 0 && dt < 0.2) {
      this.vx += ((x - this.x) / dt - this.vx) * 0.5
      this.vy += ((y - this.y) / dt - this.vy) * 0.5
    } else this.vx = this.vy = 0
    this.x = x
    this.y = y
    this.movedAt = t
  }

  press(gesture: Gesture, x: number, y: number, t: number) {
    this.move(x, y, t)
    this.thumbing = undefined
    this.held = gesture
  }

  /** Let go: the hand opens, which drops, places or plants whatever it held. */
  release(t: number) {
    if (!this.held) return
    this.held = undefined
    this.movedAt = Math.max(this.movedAt, t - STILL_MS) // stays long enough for the board to see it open
  }

  thumb(up: boolean, t: number) {
    if (this.held) return
    this.thumbing = { gesture: up ? 'thumbUp' : 'thumbDown', until: t + THUMB_MS }
    this.movedAt = Math.max(this.movedAt, t)
  }

  /** The mouse left the window or the page lost focus: nothing stays held. */
  leave() {
    this.held = this.thumbing = undefined
    this.movedAt = -Infinity
  }

  /** A button is down. */
  get holding(): boolean {
    return !!this.held
  }

  /** Whether there is a mouse hand to show at time `t`. */
  live(t: number): boolean {
    return !!this.held || (!!this.thumbing && t < this.thumbing.until) || t - this.movedAt <= IDLE_MS
  }

  hand(t: number): Hand | undefined {
    if (!this.live(t)) {
      this.fresh = true
      this.thumbing = undefined
      return undefined
    }
    if (this.thumbing && t >= this.thumbing.until) this.thumbing = undefined
    const want = this.fresh ? 'palm' : this.held ?? this.thumbing?.gesture ?? 'palm'
    if (this.fresh) { this.fresh = false; this.gesture = 'palm'; this.since = t }
    if (want !== this.gesture) { this.gesture = want; this.since = t }
    if (t - this.movedAt > STILL_MS) this.vx = this.vy = 0
    const { x, y, vx, vy, gesture } = this
    return { id: MOUSE_HAND, x, y, tipX: x, tipY: y, vx, vy, gesture, gestureSince: this.since, score: 1, landmarks: [], raw: gesture, label: 'mouse', fingers: [] }
  }
}

/** Which hand shape a mouse press stands for. `pointing`: where a plain press should point, in delete mode and on a zone's title. */
export function pressGesture(e: { button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }, pointing = false): Gesture {
  if (pointing || e.button === 2 || e.shiftKey || e.ctrlKey) return 'point'
  if (e.button === 1 || e.altKey) return 'victory'
  return 'fist'
}
