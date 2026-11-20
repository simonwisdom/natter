/**
 * Counts how steadily a run of frames was tracked, so the same recording can be replayed
 * with a fix on and off and the two compared. Pure.
 */
import type { Hand } from './body'

export const SHORT_MS = 100

export class Score {
  frames = 0
  /** Frames in which the camera code found at least one hand, before any tracking. */
  framesWithRawHand = 0
  /** Tracked hands summed over frames: more means hands were kept for longer. */
  handFrames = 0
  /** Times a tracked hand disappeared. */
  lost = 0
  /** Times a hand's frame-by-frame reading changed, and how many of those readings lasted under SHORT_MS. */
  readingChanges = 0
  shortReadings = 0
  /** Times a hand's settled gesture (what the board acts on) changed. */
  gestureChanges = 0
  private last = new Map<number, { raw: string; rawAt: number; gesture: string }>()

  frame(t: number, rawHands: number, hands: Hand[]) {
    this.frames++
    if (rawHands) this.framesWithRawHand++
    this.handFrames += hands.length
    const here = new Set(hands.map(h => h.id))
    for (const id of [...this.last.keys()]) if (!here.has(id)) { this.lost++; this.last.delete(id) }
    for (const h of hands) {
      const l = this.last.get(h.id)
      if (!l) { this.last.set(h.id, { raw: h.raw, rawAt: t, gesture: h.gesture }); continue }
      if (h.raw !== l.raw) {
        this.readingChanges++
        if (t - l.rawAt < SHORT_MS) this.shortReadings++
        l.raw = h.raw
        l.rawAt = t
      }
      if (h.gesture !== l.gesture) { this.gestureChanges++; l.gesture = h.gesture }
    }
  }

  result() {
    const { frames, framesWithRawHand, handFrames, lost, readingChanges, shortReadings, gestureChanges } = this
    return { frames, framesWithRawHand, handFrames, lost, readingChanges, shortReadings, gestureChanges }
  }
}
