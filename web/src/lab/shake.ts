/**
 * Spots a finger being shaken from side to side: several quick changes of direction, each
 * after a real swing. Used to put the fire out (leave delete mode). Pure and clock-driven.
 */
export const SWING = 0.03 // board widths a swing must cover before turning back counts
export const TURNS = 4 // changes of direction ...
export const WITHIN_MS = 1000 // ... inside this long

export class Shake {
  private far?: number // the furthest point reached in the current direction
  private dir = 0
  private turns: number[] = []

  /** Feed the finger's position across the board; true on the frame a shake completes. */
  update(x: number, t: number): boolean {
    if (this.far === undefined) { this.far = x; return false }
    const d = x - this.far
    if (this.dir === 0) {
      if (Math.abs(d) >= SWING) { this.dir = Math.sign(d); this.far = x }
      return false
    }
    if (Math.sign(d) === this.dir) { this.far = x; return false }
    if (Math.abs(d) < SWING) return false
    this.dir = -this.dir
    this.far = x
    this.turns = this.turns.filter(at => t - at <= WITHIN_MS)
    this.turns.push(t)
    if (this.turns.length < TURNS) return false
    this.turns = []
    return true
  }
}
