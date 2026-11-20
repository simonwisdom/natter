/**
 * Turns per-frame pose landmarks into people with stable ids and a raised-hand flag.
 * Landmark indices follow MediaPipe Pose: 0 nose, 11/12 shoulders, 13/14 elbows, 15/16 wrists.
 */

export interface Landmark {
  x: number
  y: number
  visibility?: number
}

export interface Person {
  id: string
  /** Shoulder midpoint, mirrored so it matches what people see on screen. */
  x: number
  raised: boolean
  landmarks: Landmark[]
}

const VISIBLE = 0.5
const MATCH_DISTANCE = 0.18
const FORGET_MS = 1500

const seen = (l?: Landmark) => !!l && (l.visibility ?? 1) >= VISIBLE

/**
 * A hand counts as raised when the wrist is above the nose (or well above the
 * shoulder if the face isn't visible). That is stricter than "above the shoulder"
 * (SPEC D6), to cut false triggers from animated talking; tune it in room tests.
 */
export function isHandRaised(lm: Landmark[]): boolean {
  const nose = lm[0]
  for (const [shoulder, wrist] of [[11, 15], [12, 16]] as const) {
    const s = lm[shoulder], w = lm[wrist]
    if (!seen(s) || !seen(w)) continue
    const top = seen(nose) ? Math.min(nose.y, s.y - 0.1) : s.y - 0.15
    if (w.y < top) return true
  }
  return false
}

export class PeopleTracker {
  private tracks: { id: string; x: number; lastSeen: number }[] = []
  private nextId = 1

  update(poses: Landmark[][], t: number): Person[] {
    const people: Person[] = []
    const free = [...this.tracks]
    for (const lm of poses) {
      const l = lm[11], r = lm[12]
      if (!l || !r) continue
      const x = 1 - (l.x + r.x) / 2
      let best = -1, bestD = MATCH_DISTANCE
      free.forEach((tr, i) => {
        const d = Math.abs(tr.x - x)
        if (d < bestD) { bestD = d; best = i }
      })
      let track
      if (best >= 0) {
        track = free.splice(best, 1)[0]
        track.x = x
        track.lastSeen = t
      } else {
        track = { id: `p${this.nextId++}`, x, lastSeen: t }
        this.tracks.push(track)
      }
      people.push({ id: track.id, x, raised: isHandRaised(lm), landmarks: lm })
    }
    this.tracks = this.tracks.filter(tr => t - tr.lastSeen < FORGET_MS)
    return people.sort((a, b) => a.x - b.x)
  }
}

const PERSON_COLOURS = ['#f08a3c', '#3cc7b4', '#b48cf0', '#f05a7e', '#8ccf4d', '#4da3f0']

export function personColour(id: string): string {
  if (id === 'key') return '#e9e3d6'
  const n = parseInt(id.replace(/\D/g, ''), 10) || 1
  return PERSON_COLOURS[(n - 1) % PERSON_COLOURS.length]
}

export function personName(id: string): string {
  return id === 'key' ? 'Keyboard' : `Person ${id.replace(/\D/g, '')}`
}
