/**
 * Buttons at the side of the board that a pointing finger presses by resting on them: the
 * way into the modes (delete, draw zones) without the keyboard. A ring of time, not a push,
 * because the camera can't tell how far forward a finger is. Pure and clock-driven.
 */
import type { Hand } from './body'

export const PRESS_MS = 700

/** A button's place on the board, in board fractions. */
export interface RailButton { id: string; x0: number; y0: number; x1: number; y1: number }

export class Rail {
  /** The button a finger is resting on, and since when: drawn as it fills. */
  aim?: { hand: number; id: string; since: number }
  /** Hands that have pressed and not yet moved off: one rest is one press. */
  private spent = new Set<number>()

  /** Returns the id of a button pressed on this frame, if any. */
  update(buttons: RailButton[], hands: Hand[], t: number): string | undefined {
    let pressed: string | undefined
    let aimed = false
    for (const h of hands) {
      const on = h.gesture === 'point' && !h.resting
        ? buttons.find(b => h.tipX >= b.x0 && h.tipX <= b.x1 && h.tipY >= b.y0 && h.tipY <= b.y1) : undefined
      if (!on) { this.spent.delete(h.id); continue }
      if (this.spent.has(h.id)) continue
      if (this.aim && this.aim.hand !== h.id) continue // one finger at a time
      aimed = true
      if (this.aim?.id !== on.id) this.aim = { hand: h.id, id: on.id, since: t }
      else if (t - this.aim.since >= PRESS_MS) {
        pressed = on.id
        this.spent.add(h.id)
        this.aim = undefined
      }
    }
    if (!aimed && !pressed) this.aim = undefined
    for (const id of this.spent) if (!hands.some(h => h.id === id)) this.spent.delete(id)
    return pressed
  }

  /** Whether this hand is on a button: it shouldn't also act on the board beneath. */
  holds(hand: number): boolean {
    return this.aim?.hand === hand || this.spent.has(hand)
  }
}
