/**
 * Session log for the Body Lab: what the camera read and what the board did with it, so a
 * session can be reviewed afterwards. Events are batched to the local server, which writes
 * them to lab-sessions/<session>.jsonl. No audio or video; hand positions, gesture readings,
 * board events, and the words heard and written.
 */
import type { Hand } from './body'

type Send = (msg: object) => boolean

export class SessionLog {
  readonly session = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  private buffer: object[] = []
  private send: Send
  private t0 = performance.now()
  /** Per hand: the last undebounced and debounced readings, and when each began. */
  private last = new Map<number, { raw: string; rawAt: number; gesture: string; frames: Record<string, number> }>()
  private frames = 0
  private statAt = 0

  constructor(send: Send) {
    this.send = send
    setInterval(() => this.flush(), 2000)
    addEventListener('pagehide', () => this.flush())
  }

  /** Told of every event as it is logged, with the time into the session: the log panel shows them on screen. */
  onEvent?: (type: string, data: Record<string, unknown>, ms: number) => void

  event(type: string, data: Record<string, unknown> = {}) {
    const t = Math.round(performance.now() - this.t0)
    this.buffer.push({ t, type, ...data })
    // A message from the server is logged under its own type.
    this.onEvent?.(typeof data.type === 'string' ? data.type : type, data, t)
    if (this.buffer.length > 5000) this.buffer.shift()
  }

  /** Call once per camera frame: logs each change in what a hand is read as, and a summary every 5 s. */
  frame(hands: Hand[], fps: number, extra: Record<string, unknown> = {}) {
    this.frames++
    const now = performance.now()
    const here = new Set(hands.map(h => h.id))
    for (const [id, l] of this.last) {
      if (here.has(id)) continue
      this.event('handLost', { hand: id, raw: l.raw, gesture: l.gesture })
      this.last.delete(id)
    }
    for (const h of hands) {
      // The classifier's word, unless our own reading overrode it (e.g. label None read as point).
      const raw = `${h.raw}/${h.label || '-'}`
      const at = { x: +h.x.toFixed(2), y: +h.y.toFixed(2), score: +h.score.toFixed(2), fingers: h.fingers.map(f => +f.toFixed(2)), resting: h.resting || undefined }
      let l = this.last.get(h.id)
      if (!l) {
        l = { raw, rawAt: now, gesture: h.gesture, frames: {} }
        this.last.set(h.id, l)
        this.event('handSeen', { hand: h.id, raw, gesture: h.gesture, ...at })
      }
      if (raw !== l.raw) {
        this.event('raw', { hand: h.id, from: l.raw, to: raw, heldMs: Math.round(now - l.rawAt), ...at })
        l.raw = raw
        l.rawAt = now
      }
      if (h.gesture !== l.gesture) {
        this.event('gesture', { hand: h.id, from: l.gesture, to: h.gesture, ...at })
        l.gesture = h.gesture
      }
      l.frames[h.raw] = (l.frames[h.raw] ?? 0) + 1
    }
    if (now - this.statAt >= 5000) {
      this.statAt = now
      const readings: Record<string, Record<string, number>> = {}
      for (const [id, l] of this.last) { readings[id] = l.frames; l.frames = {} }
      this.event('stats', { fps: Math.round(fps), frames: this.frames, readings, ...extra })
      this.frames = 0
    }
  }

  flush() {
    if (!this.buffer.length) return
    if (this.send({ type: 'lab_log', session: this.session, events: this.buffer })) this.buffer = []
  }
}
