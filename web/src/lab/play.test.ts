import { describe, expect, it } from 'vitest'
import { HandTracker, fingerReach, isPointing, isVictory, margin, toBoard, type Gesture, type Hand, type RawHand } from './body'
import { ASK_MAX_MS, DIVE_MS, IDEA_ARRIVED_MS, IDEA_DWELL_MS, IDEA_KEEP_MS, IDEA_MAX_MS, Play, R, type PlayRequest } from './play'

function hand(id: number, x: number, y: number, gesture: Gesture, since = 0, vx = 0, vy = 0): Hand {
  return { id, x, y, tipX: x, tipY: y, vx, vy, gesture, gestureSince: since, score: 1, landmarks: [], raw: gesture, label: '', fingers: [] }
}

/** A raw camera hand whose palm centre lands on board position (x, y). */
function rawAt(x: number, y: number, gesture: Gesture): RawHand {
  // Invert toBoard: solve for the camera point.
  const cam = { x: 1 - (x * (1 - 2 * margin) + margin), y: y * (1 - 2 * margin) + margin }
  expect(toBoard(cam).x).toBeCloseTo(x)
  return { landmarks: Array.from({ length: 21 }, () => cam), gesture, score: 1 }
}

describe('pointing', () => {
  /** A hand whose fingers reach `reach` times the knuckle distance, each along its own direction. */
  const handWith = (reach: number[], dir: [number, number, number]) => {
    const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }))
    ;[[8, 6], [12, 10], [16, 14], [20, 18]].forEach(([tip, pip], i) => {
      lm[pip] = { x: dir[0] * 0.06, y: dir[1] * 0.06, z: dir[2] * 0.06 }
      lm[tip] = { x: dir[0] * 0.06 * reach[i], y: dir[1] * 0.06 * reach[i], z: dir[2] * 0.06 * reach[i] }
    })
    return lm
  }
  it('counts an index finger aimed anywhere, including straight at the camera', () => {
    for (const dir of [[0, -1, 0], [1, 0, 0], [0, 0, -1]] as [number, number, number][]) {
      expect(isPointing(fingerReach(handWith([1.6, 0.9, 0.9, 0.9], dir)))).toBe(true)
    }
  })
  it('reads two fingers as a victory sign, not as pointing', () => {
    const f = fingerReach(handWith([1.5, 1.5, 0.9, 0.8], [0, -1, 0]))
    expect(isVictory(f)).toBe(true)
    expect(isPointing(f)).toBe(false)
    expect(isVictory(fingerReach(handWith([1.4, 1.4, 1.4, 1.4], [0, -1, 0])))).toBe(false)
  })
  it('does not count a fist, an open hand or two fingers', () => {
    expect(isPointing(fingerReach(handWith([0.9, 0.9, 0.9, 0.9], [0, -1, 0])))).toBe(false)
    expect(isPointing(fingerReach(handWith([1.6, 1.6, 1.6, 1.6], [0, -1, 0])))).toBe(false)
    expect(isPointing(fingerReach(handWith([1.6, 1.6, 0.9, 0.9], [0, -1, 0])))).toBe(false)
  })
})

describe('HandTracker', () => {
  it('ignores a one-frame gesture flicker and keeps a fist through a short dropout', () => {
    const tr = new HandTracker()
    let t = 0
    const step = (g: Gesture) => tr.update([rawAt(0.5, 0.5, g)], (t += 33))[0]?.gesture
    expect(step('palm')).toBeUndefined() // not yet confirmed
    step('palm')
    expect(step('palm')).toBe('palm')
    for (let i = 0; i < 5; i++) step('fist')
    expect(step('fist')).toBe('fist')
    // Fist → none for 3 frames (99 ms) is shorter than the un-fist delay.
    step('none'); step('none')
    expect(step('none')).toBe('fist')
    expect(step('fist')).toBe('fist')
    for (let i = 0; i < 6; i++) step('palm')
    expect(step('palm')).toBe('palm')
  })

  it('keeps ids stable for two hands and drops a hand that disappears', () => {
    const tr = new HandTracker()
    const two = (t: number) => tr.update([rawAt(0.2, 0.5, 'palm'), rawAt(0.8, 0.5, 'palm')], t)
    two(0); two(33)
    const a = two(66)
    for (let t = 99; t < 600; t += 33) two(t)
    const b = tr.update([rawAt(0.78, 0.5, 'palm'), rawAt(0.22, 0.5, 'palm')], 600)
    expect(b.find(h => h.x > 0.5)!.id).toBe(a.find(h => h.x > 0.5)!.id)
    expect(tr.update([rawAt(0.22, 0.5, 'palm')], 700)).toHaveLength(2) // the missing hand coasts through a short dropout
    expect(tr.update([rawAt(0.22, 0.5, 'palm')], 1300)).toHaveLength(1)
  })

  it('keeps two hands apart when one moves next to where the other was', () => {
    const tr = new HandTracker()
    for (let t = 0; t < 300; t += 33) tr.update([rawAt(0.3, 0.3, 'fist'), rawAt(0.5, 0.55, 'palm')], t)
    // The fist jumps to right beside the open hand, which moves away, and the detections swap order.
    const after = tr.update([rawAt(0.7, 0.6, 'palm'), rawAt(0.43, 0.5, 'fist')], 333)
    const fist = after.find(h => h.x < 0.5)!, palm = after.find(h => h.x > 0.5)!
    expect(fist.gesture).toBe('fist')
    expect(palm.gesture).toBe('palm')
  })

  it('ignores a one-frame phantom hand and a second detection of the same hand', () => {
    const tr = new HandTracker()
    for (let t = 0; t < 200; t += 33) tr.update([rawAt(0.3, 0.5, 'palm')], t)
    expect(tr.update([rawAt(0.3, 0.5, 'palm'), rawAt(0.8, 0.5, 'fist')], 200)).toHaveLength(1) // one frame only
    expect(tr.update([rawAt(0.3, 0.5, 'palm')], 233)).toHaveLength(1)
    for (let t = 266; t < 500; t += 33) {
      expect(tr.update([rawAt(0.3, 0.5, 'palm'), rawAt(0.32, 0.51, 'fist')], t)).toHaveLength(1) // the same hand, seen twice
    }
  })
})

const frame = (p: Play, t: number, ...hands: Hand[]) => p.update({ t, hands })

describe('Play', () => {
  it('grabs with a fist, drags, and drops on open', () => {
    const p = new Play()
    const b = p.bubbles[0]
    const { x, y } = b
    frame(p, 0, hand(1, x, y, 'palm'))
    frame(p, 33, hand(1, x, y, 'fist'))
    frame(p, 66, hand(1, x + 0.1, y + 0.2, 'fist'))
    expect(b.x).toBeCloseTo(x + 0.1)
    frame(p, 99, hand(1, x + 0.1, y + 0.2, 'palm'))
    frame(p, 132, hand(1, 0.9, 0.9, 'palm'))
    expect(b.x).toBeCloseTo(x + 0.1, 1)
    expect(b.holders).toEqual([])
    expect(p.bubbles).toContain(b)
  })

  it('flings a bubble off the board, but keeps it on the board when zones are on', () => {
    const fling = (zones: boolean) => {
      const p = new Play()
      p.modes.zones = zones
      const b = p.bubbles[0]
      frame(p, 0, hand(1, b.x, b.y, 'palm'))
      frame(p, 33, hand(1, b.x, b.y, 'fist'))
      frame(p, 66, hand(1, b.x, b.y, 'palm', 66, 3, 0))
      for (let t = 100; t < 3000; t += 33) frame(p, t)
      return { p, b }
    }
    const gone = fling(false)
    expect(gone.p.bubbles).not.toContain(gone.b)
    const kept = fling(true)
    expect(kept.p.bubbles).toContain(kept.b)
    expect(kept.b.x).toBeGreaterThan(0.6) // slid to the right-hand zone
    expect(kept.b.x).toBeLessThan(1)
  })

  it('resizes a held bubble with a second fist anywhere, then keeps it in the first hand', () => {
    const p = new Play()
    const b = p.bubbles[0]
    const { x, y } = b
    const n = p.bubbles.length
    frame(p, 0, hand(1, x, y, 'palm'), hand(2, x + 0.2, y + 0.5, 'palm'))
    frame(p, 33, hand(1, x, y, 'fist'), hand(2, x + 0.2, y + 0.5, 'palm'))
    frame(p, 66, hand(1, x, y, 'fist'), hand(2, x + 0.2, y, 'fist'))
    expect(b.holders).toEqual([1, 2])
    expect(p.ideas.size).toBe(0)
    frame(p, 99, hand(1, x, y, 'fist'), hand(2, x + 0.4, y, 'fist'))
    const grown = 1 + 0.2 * p.aspect * 2.6 // the hands moved 0.2 of the board's width further apart
    expect(b.scale).toBeCloseTo(grown)
    expect(b.x).toBeCloseTo(x)
    frame(p, 132, hand(1, x, y, 'palm'), hand(2, x + 0.4, y, 'fist'))
    frame(p, 165, hand(1, x, y, 'palm'), hand(2, x + 0.5, y, 'fist'))
    expect(b.x).toBeCloseTo(x + 0.1)
    expect(b.scale).toBeCloseTo(grown) // off the workbench, the new size stays
    expect(p.bubbles).toHaveLength(n)
  })

  it('opens a bubble only when it is stretched on purpose, not when merges grow it', () => {
    const p = new Play()
    const b = p.bubbles[0]
    b.scale = 2.2 // as large as a few merges make it
    expect(b.opened).toBeFalsy()
    const { x, y } = b
    frame(p, 0, hand(1, x, y, 'palm'), hand(2, x + 0.3, y, 'palm'))
    frame(p, 33, hand(1, x, y, 'fist'), hand(2, x + 0.3, y, 'palm'))
    frame(p, 66, hand(1, x, y, 'fist'), hand(2, x + 0.3, y, 'fist'))
    frame(p, 99, hand(1, x, y, 'fist'), hand(2, x + 0.35, y, 'fist'))
    expect(b.opened).toBe(true) // pulled apart while large
    frame(p, 132, hand(1, x, y, 'fist'), hand(2, x + 0.05, y, 'fist'))
    expect(b.scale).toBeLessThan(1.6)
    expect(b.opened).toBe(false) // squeezed back small, it closes
    p.resizeAt(b.x, b.y, 1.6, 200)
    expect(b.opened).toBe(true) // the mouse wheel opens it too
  })

  it('treats two fists closed at nearly the same time as one two-handed grab', () => {
    const p = new Play()
    const b = p.bubbles[0]
    const n = p.bubbles.length
    frame(p, 0, hand(1, b.x, b.y, 'palm'), hand(2, 0.5, 0.5, 'palm'))
    frame(p, 33, hand(1, b.x, b.y, 'palm'), hand(2, 0.5, 0.5, 'fist'))
    frame(p, 99, hand(1, b.x, b.y, 'fist'), hand(2, 0.5, 0.5, 'fist'))
    expect([...b.holders].sort()).toEqual([1, 2])
    expect(p.ideas.size).toBe(0)
    frame(p, 132, hand(1, b.x, b.y, 'palm'), hand(2, 0.5, 0.5, 'palm'))
    expect(p.bubbles).toHaveLength(n)
  })

  it('holds an idea in a fist over empty space and places it on open', () => {
    const p = new Play()
    const n = p.bubbles.length
    frame(p, 0, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.5, 'fist'))
    expect(p.ideas.size).toBe(0) // a fist has to stay closed a moment: a missed grab isn't an idea
    expect(p.aims.get(1)?.kind).toBe('idea')
    frame(p, 400, hand(1, 0.5, 0.5, 'fist'))
    expect(p.ideas.has(1)).toBe(true)
    frame(p, 433, hand(1, 0.5, 0.5, 'palm'))
    expect(p.bubbles).toHaveLength(n + 1)
    const born = p.bubbles.at(-1)!
    expect(born.x).toBeCloseTo(0.5)
    expect(born.pending).toBe(false) // nobody listening: placeholder words
    expect(born.text).not.toBe('…')
    expect(p.ideas.size).toBe(0)
  })

  it('asks for words through onRequest and takes them back through setText', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    frame(p, 0, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 400, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 433, hand(1, 0.5, 0.5, 'palm'))
    const born = p.bubbles.at(-1)!
    expect(reqs).toEqual([{ kind: 'listenStart', hand: 1 }, { kind: 'listenEnd', hand: 1, bubbleId: born.id }])
    expect(born.pending).toBe(true)
    p.setText(born.id, 'Standing only', '🧍')
    expect(born).toMatchObject({ text: 'Standing only', emoji: '🧍', pending: false })
  })

  it('abandons a held idea when the hand disappears', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const n = p.bubbles.length
    frame(p, 0, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 400, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 433)
    expect(p.bubbles).toHaveLength(n)
    expect(reqs.at(-1)).toEqual({ kind: 'listenEnd', hand: 1 })
  })

  it('starts a branch when a pointing finger rests on a bubble, however it got there', () => {
    const p = new Play()
    const b = p.bubbles[0]
    // Already pointing, off any bubble; then the fingertip slides onto one.
    frame(p, 0, hand(1, 0.5, 0.5, 'point'))
    frame(p, 33, hand(1, b.x, b.y, 'point'))
    expect(p.aims.get(1)?.bubble).toBe(b.id)
    expect(p.ideas.size).toBe(0) // not yet: it has to rest there a moment
    frame(p, 300, hand(1, b.x, b.y, 'point'))
    expect(p.ideas.size).toBe(0)
    frame(p, 450, hand(1, b.x, b.y, 'point'))
    expect(p.ideas.get(1)?.parent).toBe(b.id)
    expect(p.aims.size).toBe(0)
  })

  it('does not start a branch for a finger that only passes over a bubble', () => {
    const p = new Play()
    const b = p.bubbles[0]
    frame(p, 0, hand(1, b.x, b.y, 'point'))
    frame(p, 100, hand(1, b.x, b.y, 'point'))
    frame(p, 200, hand(1, 0.5, 0.5, 'point'))
    frame(p, 400, hand(1, 0.5, 0.5, 'point'))
    expect(p.ideas.size).toBe(0)
  })

  it('plants a branch where the fingertip was when the hand opens, and it follows its parent', () => {
    const p = new Play()
    const b = p.bubbles[0]
    frame(p, 0, hand(1, b.x, b.y, 'point'))
    frame(p, 410, hand(1, b.x, b.y, 'point'))
    frame(p, 420, hand(1, b.x + 0.1, b.y + 0.25, 'point'))
    frame(p, 366, hand(1, b.x + 0.1, b.y + 0.25, 'none')) // a flicker doesn't plant it
    frame(p, 400, hand(1, b.x + 0.1, b.y + 0.25, 'fist')) // nor does curling the finger
    expect(p.ideas.size).toBe(1)
    frame(p, 433, hand(1, b.x + 0.12, b.y + 0.3, 'palm'))
    const child = p.bubbles.at(-1)!
    expect(child.parent).toBe(b.id)
    expect(child.colour).toBe(b.colour)
    expect(child.y).toBeCloseTo(b.y + 0.25, 1)
    frame(p, 466, hand(1, b.x, b.y, 'fist'))
    for (let t = 500; t < 2800; t += 33) frame(p, t, hand(1, 0.85, 0.2, 'fist'))
    expect(Math.hypot((child.x - b.x) * p.aspect, child.y - b.y)).toBeLessThan(0.4)
  })

  it('cancels a branch when the hand opens before it was pulled clear of its bubble', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const b = p.bubbles[0]
    const n = p.bubbles.length
    frame(p, 0, hand(1, b.x, b.y, 'point'))
    frame(p, 410, hand(1, b.x, b.y, 'point'))
    frame(p, 420, hand(1, b.x + 0.02, b.y + 0.03, 'point'))
    frame(p, 366, hand(1, b.x + 0.02, b.y + 0.03, 'palm'))
    expect(p.bubbles).toHaveLength(n)
    expect(p.ideas.size).toBe(0)
    expect(reqs.at(-1)).toEqual({ kind: 'listenEnd', hand: 1 })
  })

  it('merges a bubble dropped onto another and asks for the combined idea', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const [a, b] = p.bubbles
    const n = p.bubbles.length
    const names = [a.text, b.text]
    frame(p, 0, hand(1, a.x, a.y, 'palm'))
    frame(p, 33, hand(1, a.x, a.y, 'fist'))
    frame(p, 66, hand(1, b.x + 0.01, b.y, 'fist'))
    expect(a.mergeInto).toBe(b.id)
    frame(p, 99, hand(1, b.x + 0.01, b.y, 'palm'))
    expect(p.bubbles).toHaveLength(n - 1)
    expect(p.bubbles).not.toContain(a)
    expect(b.scale).toBeGreaterThan(1.3)
    expect(b.opened).toBeFalsy()
    expect(reqs.at(-1)).toEqual({ kind: 'rework', bubbleId: b.id, how: 'combine', idea: names[0], other: names[1] })
    expect(b.pending).toBe(true)
  })

  it('does not merge when the camera loses the hand over another bubble', () => {
    const p = new Play()
    const [a, b] = p.bubbles
    const n = p.bubbles.length
    frame(p, 0, hand(1, a.x, a.y, 'palm'))
    frame(p, 33, hand(1, a.x, a.y, 'fist'))
    frame(p, 66, hand(1, b.x + 0.01, b.y, 'fist'))
    frame(p, 99) // hand gone
    expect(p.bubbles).toHaveLength(n)
    expect(p.bubbles).toContain(a)
  })

  it('undoes a merge, a bin and a new idea, and clear can be undone', () => {
    const p = new Play()
    const [a, b] = p.bubbles
    const texts = () => p.bubbles.map(k => k.text).sort()
    const start = texts()
    frame(p, 0, hand(1, a.x, a.y, 'palm'))
    frame(p, 33, hand(1, a.x, a.y, 'fist'))
    frame(p, 66, hand(1, b.x + 0.01, b.y, 'fist'))
    frame(p, 99, hand(1, b.x + 0.01, b.y, 'palm'))
    expect(texts()).not.toEqual(start)
    expect(p.undo()).toBe(true)
    expect(texts()).toEqual(start) // split apart again
    expect(p.bubbles.find(k => k.id === a.id)!.scale).toBe(1)

    const c = p.bubbles[0]
    frame(p, 200, hand(1, c.x, c.y, 'thumbDown', 200))
    frame(p, 850, hand(1, c.x, c.y, 'thumbDown', 200))
    expect(p.bubbles.find(k => k.id === c.id)!.leaving).toBe('bin')
    p.undo()
    expect(p.bubbles.find(k => k.id === c.id)!.leaving).toBeUndefined()

    frame(p, 900, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 933, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 1300, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 1333, hand(1, 0.5, 0.5, 'palm'))
    expect(p.bubbles).toHaveLength(start.length + 1)
    p.undo()
    expect(texts()).toEqual(start)

    p.clear()
    expect(p.bubbles).toHaveLength(0)
    p.undo()
    expect(texts()).toEqual(start)
  })

  it('ignores a second fist on empty space while another hand is holding an idea', () => {
    const p = new Play()
    const n = p.bubbles.length
    frame(p, 0, hand(1, 0.5, 0.5, 'palm'), hand(2, 0.5, 0.9, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.5, 'fist'), hand(2, 0.5, 0.9, 'palm'))
    frame(p, 1000, hand(1, 0.5, 0.5, 'fist'), hand(2, 0.5, 0.9, 'fist'))
    expect(p.ideas.size).toBe(1)
    frame(p, 1033, hand(1, 0.5, 0.5, 'fist'), hand(2, 0.5, 0.9, 'palm'))
    expect(p.bubbles).toHaveLength(n)
  })

  it('on the workbench, a stretch, squeeze or crossing grows a reworked branch and leaves the size alone', () => {
    const cases: [number, number, string][] = [[0.2, 0.5, 'further'], [0.3, 0.1, 'smaller'], [0.2, -0.2, 'opposite']]
    for (const [from, to, how] of cases) {
      const p = new Play()
      p.modes.workbench = true
      const reqs: PlayRequest[] = []
      p.onRequest = r => reqs.push(r)
      const b = p.bubbles[1]
      const { x, y } = b
      frame(p, 0, hand(1, x, y, 'palm'), hand(2, x + from, y, 'palm'))
      frame(p, 33, hand(1, x, y, 'fist'), hand(2, x + from, y, 'palm'))
      frame(p, 66, hand(1, x, y, 'fist'), hand(2, x + from, y, 'fist'))
      frame(p, 99, hand(1, x, y, 'fist'), hand(2, x + to, y, 'fist'))
      expect(b.hint).toBe(how)
      frame(p, 132, hand(1, x, y, 'fist'), hand(2, x + to, y, 'palm'))
      expect(b.scale).toBe(1)
      const v = p.bubbles.at(-1)!
      expect(v.parent).toBe(b.id)
      expect(reqs.at(-1)).toEqual({ kind: 'rework', bubbleId: v.id, how, idea: b.text, other: undefined })
    }
  })

  it('stars with a held thumbs up (once per hold) and bins with thumbs down', () => {
    const p = new Play()
    const b = p.bubbles[0]
    frame(p, 0, hand(1, b.x, b.y, 'thumbUp', 0))
    expect(b.starred).toBe(false)
    frame(p, 650, hand(1, b.x, b.y, 'thumbUp', 0))
    frame(p, 683, hand(1, b.x, b.y, 'thumbUp', 0))
    expect(b.starred).toBe(true)
    frame(p, 700, hand(1, b.x, b.y, 'thumbDown', 700))
    frame(p, 1350, hand(1, b.x, b.y, 'thumbDown', 700))
    expect(b.leaving).toBe('bin')
    for (let t = 1400; t < 3500; t += 33) frame(p, t)
    expect(p.bubbles).not.toContain(b)
  })

  it('gives each new root idea its own colour, and a merged family the colour it joined', () => {
    const p = new Play()
    p.clear()
    const make = (x: number, t: number) => {
      frame(p, t, hand(1, x, 0.5, 'palm'))
      frame(p, t + 33, hand(1, x, 0.5, 'fist'))
      frame(p, t + 400, hand(1, x, 0.5, 'fist'))
      frame(p, t + 433, hand(1, x, 0.5, 'palm'))
      return p.bubbles.at(-1)!
    }
    const a = make(0.2, 0), b = make(0.5, 500), c = make(0.8, 1000)
    expect(new Set([a.colour, b.colour, c.colour]).size).toBe(3)
    // Branch from a, then drop a onto b: the branch follows into b's family and colour.
    frame(p, 1500, hand(1, a.x, a.y, 'point'))
    frame(p, 1910, hand(1, a.x, a.y, 'point'))
    frame(p, 1940, hand(1, a.x, a.y + 0.3, 'point'))
    frame(p, 1970, hand(1, a.x, a.y + 0.3, 'palm'))
    const child = p.bubbles.at(-1)!
    expect(child.colour).toBe(a.colour)
    frame(p, 2000, hand(1, a.x, a.y, 'fist'))
    frame(p, 2033, hand(1, b.x + 0.01, b.y, 'fist'))
    frame(p, 2066, hand(1, b.x + 0.01, b.y, 'palm'))
    expect(child.parent).toBe(b.id)
    expect(child.colour).toBe(b.colour)
    expect(b.full).toContain('+')
  })

  it('connects two existing bubbles when a shoot lands on another, and disconnects the same way', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const [a, b] = p.bubbles
    const n = p.bubbles.length
    const pull = (t: number) => {
      frame(p, t, hand(1, a.x, a.y, 'point'))
      frame(p, t + 410, hand(1, a.x, a.y, 'point'))
      frame(p, t + 440, hand(1, b.x, b.y, 'point'))
      expect(p.ideas.get(1)?.over).toBe(b.id)
      frame(p, t + 470, hand(1, b.x, b.y, 'palm'))
    }
    pull(0)
    expect(p.links).toEqual([[a.id, b.id]])
    expect(p.bubbles).toHaveLength(n) // no new bubble
    expect(reqs.at(-1)).toEqual({ kind: 'listenEnd', hand: 1 })
    pull(1000)
    expect(p.links).toEqual([])
    p.undo()
    expect(p.links).toEqual([[a.id, b.id]])
  })

  it('puts out two branches when a victory sign rests on a bubble, and asks the LLM once the sign is lowered', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const b = p.bubbles[0]
    const n = p.bubbles.length
    frame(p, 0, hand(1, b.x, b.y, 'victory'))
    frame(p, 200, hand(1, b.x, b.y, 'victory'))
    expect(reqs).toHaveLength(0)
    frame(p, 450, hand(1, b.x, b.y, 'victory'))
    expect(reqs).toEqual([{ kind: 'askStart', hand: 1 }]) // listening for an angle
    const made = p.bubbles.slice(n)
    expect(made).toHaveLength(2)
    expect(made.every(v => v.parent === b.id && v.pending && v.byClaude && v.colour === b.colour)).toBe(true)
    for (let t = 500; t < 2000; t += 100) frame(p, t, hand(1, b.x, b.y, 'victory'))
    expect(reqs).toHaveLength(1) // holding the sign keeps listening; it neither sends nor asks again
    frame(p, 2000, hand(1, b.x, b.y, 'palm'))
    frame(p, 2300, hand(1, b.x, b.y, 'palm'))
    const ask = reqs.at(-1)!
    expect(ask).toMatchObject({ kind: 'suggest', hand: 1, idea: b.text, bubbleIds: made.map(v => v.id) })
    if (ask.kind !== 'suggest') return
    expect(ask.board).toHaveLength(n - 1)
    expect(ask).not.toHaveProperty('other')
    expect(reqs.filter(r => r.kind === 'suggest')).toHaveLength(1)
    expect(p.asks.size).toBe(0)
  })

  it('keeps an ask open through a misread frame, and the hand does nothing else meanwhile', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const b = p.bubbles[0]
    frame(p, 0, hand(1, b.x, b.y, 'victory'))
    frame(p, 450, hand(1, b.x, b.y, 'victory'))
    frame(p, 500, hand(1, b.x, b.y, 'fist')) // the sign read as a fist for a moment
    frame(p, 600, hand(1, b.x, b.y, 'victory'))
    expect(b.holders).toEqual([]) // not grabbed
    expect(p.asks.has(1)).toBe(true)
    frame(p, 800, hand(1, b.x, b.y, 'victory')) // longer than the grace since the misread, but the sign came back
    expect(reqs.filter(r => r.kind === 'suggest')).toHaveLength(0)
    frame(p, 900, hand(1, b.x, b.y, 'palm'))
    frame(p, 1200, hand(1, b.x, b.y, 'palm'))
    expect(reqs.filter(r => r.kind === 'suggest')).toHaveLength(1)
  })

  it('sends an ask by itself when the sign is left up too long or the hand is lost', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const [a, b] = p.bubbles
    frame(p, 0, hand(1, a.x, a.y, 'victory'))
    frame(p, 450, hand(1, a.x, a.y, 'victory'))
    frame(p, 450 + ASK_MAX_MS, hand(1, a.x, a.y, 'victory'))
    expect(reqs.filter(r => r.kind === 'suggest')).toHaveLength(1)
    frame(p, 9000, hand(1, a.x, a.y, 'victory'))
    frame(p, 9500, hand(1, a.x, a.y, 'victory'))
    expect(p.asks.size).toBe(0) // the same sign doesn't ask again
    frame(p, 10_000, hand(2, b.x, b.y, 'victory'))
    frame(p, 10_450, hand(2, b.x, b.y, 'victory'))
    expect(p.asks.has(2)).toBe(true)
    frame(p, 10_500) // the camera lost the hand
    expect(reqs.filter(r => r.kind === 'suggest')).toHaveLength(2)
    expect(reqs.at(-1)).toMatchObject({ kind: 'suggest', hand: 2, idea: b.text })
  })

  it('does not ask twice when a misread frame is followed by the ask sending itself', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const b = p.bubbles[0]
    frame(p, 0, hand(1, b.x, b.y, 'victory'))
    frame(p, 450, hand(1, b.x, b.y, 'victory'))
    frame(p, 500, hand(1, b.x, b.y, 'palm')) // one misread frame, inside the grace
    frame(p, 600, hand(1, b.x, b.y, 'victory'))
    frame(p, 450 + ASK_MAX_MS, hand(1, b.x, b.y, 'victory')) // left up: it sends itself
    for (let t = 9000; t < 11_000; t += 100) frame(p, t, hand(1, b.x, b.y, 'victory'))
    expect(reqs.filter(r => r.kind === 'askStart')).toHaveLength(1)
    expect(p.asks.size).toBe(0)
  })

  it('keeps the angle on a line through a merge and puts it back or takes it away on undo', () => {
    const p = new Play()
    const [a, b, c] = p.bubbles
    p.links.push([a.id, b.id])
    for (let t = 0; t < 600; t += 33) frame(p, t)
    const k = p.knot(a, b)
    frame(p, 1000, hand(1, k.x, k.y, 'victory'))
    frame(p, 1450, hand(1, k.x, k.y, 'victory'))
    frame(p, 1500)
    const kids = p.bubbles.filter(v => v.knot).map(v => v.id)
    p.setAngle(kids, 'similarities')
    // An unrelated change after the word arrived: undoing it keeps the word, because its bubbles are still here.
    frame(p, 2000, hand(1, c.x, c.y, 'palm'))
    frame(p, 2033, hand(1, c.x, c.y, 'fist'))
    frame(p, 2066, hand(1, c.x, c.y, 'palm'))
    p.undo()
    expect(p.linkWord(a.id, b.id)).toBe('similarities')
    // Merging one end into another bubble moves the word to the merged idea's line.
    frame(p, 3000, hand(1, a.x, a.y, 'palm'))
    frame(p, 3033, hand(1, a.x, a.y, 'fist'))
    frame(p, 3066, hand(1, c.x, c.y, 'fist'))
    frame(p, 3100, hand(1, c.x, c.y, 'palm'))
    expect(p.linkWord(c.id, b.id)).toBe('similarities')
    expect(p.linkWord(a.id, b.id)).toBeUndefined()
    p.undo() // the merge
    expect(p.linkWord(a.id, b.id)).toBe('similarities')
    p.undo() // the grab of c (nothing moved)
    p.undo() // the ask itself: its bubbles go, and the word with them
    expect(p.bubbles.some(v => v.knot)).toBe(false)
    expect(p.linkWord(a.id, b.id)).toBeUndefined()
  })

  it('asks about a pair when a victory sign rests on the knot of their connection', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const [a, b, c] = p.bubbles
    const n = p.bubbles.length
    b.scale = 1.6 // the knot sits in the middle of the line you can see, not between the centres
    p.links.push([a.id, b.id])
    for (let t = 0; t < 600; t += 33) frame(p, t) // they settle with room for the knot
    const k = p.knot(a, b)
    expect(p.bubbleAt(k.x, k.y)).toBeUndefined()
    expect(p.knotAt(k.x, k.y)).toEqual([a, b])
    expect(p.knotAt(c.x, c.y)).toBeUndefined()
    frame(p, 1000, hand(1, k.x, k.y, 'point'))
    frame(p, 1500, hand(1, k.x, k.y, 'point'))
    expect(reqs).toHaveLength(0) // one finger on a knot does nothing
    frame(p, 2000, hand(1, k.x, k.y, 'victory'))
    expect(p.aims.get(1)).toMatchObject({ kind: 'ask', bubble: a.id, other: b.id })
    frame(p, 2450, hand(1, k.x, k.y, 'victory'))
    expect(reqs).toEqual([{ kind: 'askStart', hand: 1 }])
    const made = p.bubbles.slice(n)
    expect(made).toHaveLength(2)
    expect(made.every(v => v.pending && v.byClaude && !v.parent && v.knot?.includes(a.id) && v.knot.includes(b.id))).toBe(true)
    expect(made[0].colour).toBe(made[1].colour)
    expect([a.colour, b.colour]).not.toContain(made[0].colour) // a family of its own
    frame(p, 2500, hand(1, k.x, k.y, 'palm'))
    frame(p, 2800, hand(1, k.x, k.y, 'palm'))
    const ask = reqs.at(-1)!
    expect(ask).toMatchObject({ kind: 'suggest', hand: 1, idea: a.text, other: b.text, branches: [], bubbleIds: made.map(v => v.id) })
    if (ask.kind !== 'suggest') return
    expect(ask.board).toHaveLength(n - 2)
    expect(ask.board).not.toContain(b.text)

    // The words arrive, with the angle the LLM understood: it stays on the line and behind each new bubble.
    p.setText(made[0].id, 'Both get you outside', '🌤️')
    p.setText(made[1].id, 'No screens', '📵')
    p.setAngle(made.map(v => v.id), 'similarities')
    expect(p.linkWord(b.id, a.id)).toBe('similarities')
    expect(made[0].full).toBe(`similarities: ${a.text} + ${b.text}`)

    // Asking the same knot again lists what already hangs there, and the new ones join that family.
    const k2 = p.knot(a, b) // the new bubbles nudged things along
    frame(p, 4000, hand(1, k2.x, k2.y, 'victory'))
    frame(p, 4450, hand(1, k2.x, k2.y, 'victory'))
    frame(p, 4500)
    const again = reqs.at(-1)!
    expect(again).toMatchObject({ kind: 'suggest', other: b.text, branches: ['Both get you outside', 'No screens'] })
    expect(p.bubbles.slice(n + 2).every(v => v.colour === made[0].colour)).toBe(true)
  })

  it('gives a spoken angle to the branches of a single bubble too, without labelling any line', () => {
    const p = new Play()
    const b = p.bubbles[0]
    const n = p.bubbles.length
    frame(p, 0, hand(1, b.x, b.y, 'victory'))
    frame(p, 450, hand(1, b.x, b.y, 'victory'))
    frame(p, 500)
    const made = p.bubbles.slice(n)
    expect(made.every(v => !v.pending)).toBe(true) // nobody listening: placeholder words
    p.setAngle(made.map(v => v.id), ' risks ')
    expect(made[0].full).toBe(`risks: ${b.text}`)
    p.setAngle(made.map(v => v.id), '  ')
    expect(made[0].full).toBe(`risks: ${b.text}`) // no angle understood: nothing changes
  })

  it('keeps connected bubbles far enough apart for the knot to be reached', () => {
    const p = new Play()
    const [a, b] = p.bubbles
    b.x = a.x + (R * 2.05) / p.aspect // almost touching
    b.y = a.y
    p.links.push([a.id, b.id])
    const k0 = p.knot(a, b)
    expect(p.bubbleAt(k0.x, k0.y)).toBeDefined() // covered
    for (let t = 0; t < 2000; t += 33) frame(p, t)
    const k = p.knot(a, b)
    expect(p.bubbleAt(k.x, k.y)).toBeUndefined()
    expect(p.knotAt(k.x, k.y)).toEqual([a, b])
  })

  it('takes an unfinished ask back when the board is undone, reset or switched to another mode', () => {
    const start = () => {
      const p = new Play()
      const reqs: PlayRequest[] = []
      p.onRequest = r => reqs.push(r)
      const b = p.bubbles[0]
      frame(p, 0, hand(1, b.x, b.y, 'victory'))
      frame(p, 450, hand(1, b.x, b.y, 'victory'))
      expect(p.bubbles.filter(v => v.pending)).toHaveLength(2)
      return { p, reqs, b }
    }
    for (const stop of [(p: Play) => p.setDeleting(true), (p: Play) => p.setDrawingZones(true), (p: Play) => p.undo(), (p: Play) => p.clear(), (p: Play) => p.reset()]) {
      const { p, reqs, b } = start()
      stop(p)
      expect(p.asks.size).toBe(0)
      expect(p.bubbles.filter(v => v.pending)).toHaveLength(0)
      expect(reqs.at(-1)).toEqual({ kind: 'listenEnd', hand: 1 }) // the microphone is let go, and nothing is sent to the LLM
      frame(p, 500, hand(1, b.x, b.y, 'palm'))
      frame(p, 900, hand(1, b.x, b.y, 'palm'))
      expect(reqs.filter(r => r.kind === 'suggest')).toHaveLength(0)
    }
  })

  it('has one microphone: an ask waits for an idea being spoken, and an idea for an ask', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const b = p.bubbles[0]
    frame(p, 0, hand(1, 0.5, 0.55, 'palm'), hand(2, b.x, b.y, 'victory'))
    frame(p, 33, hand(1, 0.5, 0.55, 'fist'), hand(2, b.x, b.y, 'palm'))
    frame(p, 400, hand(1, 0.5, 0.55, 'fist'), hand(2, b.x, b.y, 'palm'))
    expect(p.ideas.has(1)).toBe(true)
    frame(p, 500, hand(1, 0.5, 0.55, 'fist'), hand(2, b.x, b.y, 'victory'))
    frame(p, 1000, hand(1, 0.5, 0.55, 'fist'), hand(2, b.x, b.y, 'victory'))
    expect(p.asks.size).toBe(0) // the fist is still speaking its idea
    frame(p, 1033, hand(1, 0.5, 0.55, 'palm'), hand(2, b.x, b.y, 'victory'))
    frame(p, 1066, hand(1, 0.5, 0.55, 'palm'), hand(2, b.x, b.y, 'victory'))
    expect(p.asks.has(2)).toBe(true)
    frame(p, 1100, hand(1, 0.5, 0.2, 'fist'), hand(2, b.x, b.y, 'victory'))
    frame(p, 1600, hand(1, 0.5, 0.2, 'fist'), hand(2, b.x, b.y, 'victory'))
    expect(p.ideas.size).toBe(0) // and now the fist waits for the ask
  })

  it('lets go of what hung off a knot when the connection goes, and follows a merge', () => {
    const p = new Play()
    const [a, b, c] = p.bubbles
    p.links.push([a.id, b.id])
    for (let t = 0; t < 600; t += 33) frame(p, t)
    const k = p.knot(a, b)
    frame(p, 1000, hand(1, k.x, k.y, 'victory'))
    frame(p, 1450, hand(1, k.x, k.y, 'victory'))
    frame(p, 1500)
    const kids = p.bubbles.filter(v => v.knot)
    expect(kids).toHaveLength(2)
    // `a` is dropped onto `c`: the connection, and what hangs off it, now belong to `c`.
    frame(p, 2000, hand(1, a.x, a.y, 'palm'))
    frame(p, 2033, hand(1, a.x, a.y, 'fist'))
    frame(p, 2066, hand(1, c.x, c.y, 'fist'))
    frame(p, 2100, hand(1, c.x, c.y, 'palm'))
    expect(p.byId(a.id)).toBeUndefined()
    expect(kids.every(v => v.knot?.includes(c.id) && v.knot.includes(b.id))).toBe(true)
    frame(p, 2133)
    expect(kids.every(v => !!v.knot)).toBe(true)
    p.links = []
    frame(p, 2166)
    expect(kids.every(v => v.knot === undefined)).toBe(true)
    expect(p.bubbles).toEqual(expect.arrayContaining(kids)) // still on the board, on their own
  })

  it('zooms out when two fists close on empty space and push together, and not for anything less', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const n = p.bubbles.length
    const two = (t: number, gap: number, g: Gesture = 'fist') => frame(p, t, hand(1, 0.5 - gap / 2, 0.55, g), hand(2, 0.5 + gap / 2, 0.55, g))
    two(0, 0.3, 'palm')
    two(33, 0.3)
    expect(p.canvasHold).toBeDefined()
    expect(p.aims.size).toBe(0) // neither fist is counting down to a new idea
    two(500, 0.3)
    expect(p.ideas.size).toBe(0) // held still, it stays a hold on the canvas
    two(600, 0.4) // pulled apart in the work view: nothing
    expect(p.overview).toBe(false)
    two(700, 0.27) // a small squeeze: nothing
    expect(p.overview).toBe(false)
    two(800, 0.15)
    expect(p.overview).toBe(true)
    expect(p.bubbles).toHaveLength(n)
    expect(reqs.filter(r => r.kind === 'area')).toHaveLength(1) // this area needs a name
    expect(reqs.some(r => r.kind === 'listenStart')).toBe(false)
  })

  it('does not zoom out when one fist is on a bubble, or when the second fist comes late', () => {
    const p = new Play()
    const b = p.bubbles[0]
    frame(p, 0, hand(1, b.x, b.y, 'palm'), hand(2, 0.5, 0.55, 'palm'))
    frame(p, 33, hand(1, b.x, b.y, 'fist'), hand(2, 0.5, 0.55, 'fist'))
    expect(p.canvasHold).toBeUndefined()
    expect(b.holders).toHaveLength(2) // the old two-handed grab
    const q = new Play()
    frame(q, 0, hand(1, 0.3, 0.55, 'palm'), hand(2, 0.7, 0.55, 'palm'))
    frame(q, 33, hand(1, 0.3, 0.55, 'fist'), hand(2, 0.7, 0.55, 'palm'))
    frame(q, 400, hand(1, 0.3, 0.55, 'fist'), hand(2, 0.7, 0.55, 'palm'))
    expect(q.ideas.has(1)).toBe(true)
    frame(q, 1200, hand(1, 0.3, 0.55, 'fist'), hand(2, 0.7, 0.55, 'fist')) // more than a moment later
    frame(q, 1300, hand(1, 0.4, 0.55, 'fist'), hand(2, 0.5, 0.55, 'fist'))
    expect(q.canvasHold).toBeUndefined()
    expect(q.overview).toBe(false)
    expect(q.ideas.has(1)).toBe(true) // the idea is still in the first fist
  })

  it('gives up an idea just started when the second fist closes straight after, and holds the canvas instead', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const n = p.bubbles.length
    frame(p, 0, hand(1, 0.3, 0.55, 'palm'), hand(2, 0.7, 0.55, 'palm'))
    frame(p, 33, hand(1, 0.3, 0.55, 'fist'), hand(2, 0.7, 0.55, 'palm'))
    frame(p, 400, hand(1, 0.3, 0.55, 'fist'), hand(2, 0.7, 0.55, 'palm'))
    expect(p.ideas.has(1)).toBe(true)
    frame(p, 600, hand(1, 0.3, 0.55, 'fist'), hand(2, 0.7, 0.55, 'fist'))
    expect(p.ideas.size).toBe(0)
    expect(p.canvasHold).toBeDefined()
    expect(reqs.at(-1)).toEqual({ kind: 'listenEnd', hand: 1 }) // the microphone is let go, no bubble made
    expect(p.bubbles).toHaveLength(n)
  })

  it('shows every area in the overview and goes into one a finger rests on; an empty one is fresh space', () => {
    const p = new Play()
    const first = [...p.bubbles]
    p.setOverview(true)
    let cells = p.cells()
    expect(cells).toHaveLength(9) // this area and a ring of empty ones
    expect(cells.filter(c => c.current)).toHaveLength(1)
    expect(cells.find(c => c.current)!.bubbles).toHaveLength(first.length)
    expect(cells.find(c => c.current)!.name).toBe(`${first[0].text} +${first.length - 1}`) // a stand-in until the LLM names it
    p.setAreaName('0,0', 'Days off', '🌤️')
    expect(p.cells().find(c => c.current)).toMatchObject({ name: 'Days off', emoji: '🌤️' })
    // Hands move nothing here.
    frame(p, 0, hand(1, first[0].x, first[0].y, 'palm'))
    frame(p, 33, hand(1, first[0].x, first[0].y, 'fist'))
    frame(p, 600, hand(1, first[0].x + 0.2, first[0].y, 'fist'))
    expect(first[0].holders).toEqual([])
    expect(p.ideas.size).toBe(0)
    // A pointing finger resting on the tile to the right goes there.
    const right = cells.find(c => c.col === 1 && c.row === 0)!
    const mx = (right.x0 + right.x1) / 2, my = (right.y0 + right.y1) / 2
    frame(p, 1000, hand(1, mx, my, 'point'))
    expect(p.overviewAim).toMatchObject({ key: '1,0' })
    frame(p, 1000 + DIVE_MS - 50, hand(1, mx, my, 'point'))
    expect(p.overview).toBe(true)
    frame(p, 1000 + DIVE_MS, hand(1, mx, my, 'point'))
    expect(p.overview).toBe(false)
    expect(p.area).toEqual({ col: 1, row: 0 })
    expect(p.bubbles).toEqual([]) // fresh space
    expect(p.undo()).toBe(false) // with its own history
    // A new idea here, then back out: both areas are on the canvas, with a ring around them.
    frame(p, 3000, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 3033, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 3400, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 3433, hand(1, 0.5, 0.5, 'palm'))
    expect(p.bubbles).toHaveLength(1)
    p.setOverview(true)
    cells = p.cells()
    expect(cells).toHaveLength(12) // two across, plus the ring
    expect(cells.find(c => c.key === '0,0')).toMatchObject({ current: false, name: 'Days off' })
    expect(cells.find(c => c.key === '0,0')!.bubbles.map(b => b.id)).toEqual(first.map(b => b.id))
    expect(cells.find(c => c.key === '1,0')).toMatchObject({ current: true })
    // Zooming back in without choosing returns to where you were.
    p.setOverview(false)
    expect(p.area).toEqual({ col: 1, row: 0 })
    expect(p.bubbles).toHaveLength(1)
    // Going back to the first area finds it as it was left, undo history and all.
    p.dive(0, 0)
    expect(p.bubbles.map(b => b.text)).toEqual(first.map(b => b.text))
    p.dive(1, 0)
    p.clear()
    p.dive(0, 0) // an area left empty is forgotten
    p.setOverview(true)
    expect(p.cells()).toHaveLength(9)
  })

  it('goes into the area between two fists pulled apart, and closed fists do nothing until they open', () => {
    const p = new Play()
    p.setOverview(true)
    const cell = p.cells().find(c => c.col === 0 && c.row === 1)! // below
    const mx = (cell.x0 + cell.x1) / 2, my = (cell.y0 + cell.y1) / 2
    const two = (t: number, gap: number, g: Gesture = 'fist') => frame(p, t, hand(1, mx - gap / 2, my, g), hand(2, mx + gap / 2, my, g))
    two(0, 0.1, 'palm')
    two(33, 0.1)
    two(100, 0.14)
    expect(p.overview).toBe(true)
    two(200, 0.3)
    expect(p.overview).toBe(false)
    expect(p.area).toEqual({ col: 0, row: 1 })
    // The fists are still closed, on empty space: no new idea, no hold, until they open.
    for (let t = 300; t < 1500; t += 100) two(t, 0.3)
    expect(p.ideas.size).toBe(0)
    expect(p.aims.size).toBe(0)
    expect(p.canvasHold).toBeUndefined()
    two(1600, 0.3, 'palm')
    frame(p, 1700, hand(1, mx, my, 'fist'), hand(2, mx + 0.3, my, 'palm'))
    frame(p, 2100, hand(1, mx, my, 'fist'), hand(2, mx + 0.3, my, 'palm'))
    expect(p.ideas.has(1)).toBe(true) // open, then closed again: it works as usual
  })

  it('takes back what is in hand when zooming out, and keeps out of delete mode and zone drawing', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const b = p.bubbles[0]
    const n = p.bubbles.length
    frame(p, 0, hand(1, b.x, b.y, 'victory'))
    frame(p, 450, hand(1, b.x, b.y, 'victory'))
    expect(p.asks.size).toBe(1)
    p.setOverview(true)
    expect(p.asks.size).toBe(0)
    expect(p.bubbles).toHaveLength(n) // the ask's empty bubbles are gone
    expect(reqs.some(r => r.kind === 'suggest')).toBe(false)
    p.setOverview(false)
    p.setDeleting(true)
    p.setOverview(true)
    expect(p.overview).toBe(false)
    p.setDeleting(false)
    p.setDrawingZones(true)
    p.setOverview(true)
    expect(p.overview).toBe(false)
  })

  it('delivers words to a bubble whose area was left while it waited, and can take it back', () => {
    const p = new Play()
    p.onRequest = () => {}
    frame(p, 0, hand(1, 0.5, 0.55, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.55, 'fist'))
    frame(p, 400, hand(1, 0.5, 0.55, 'fist'))
    frame(p, 433, hand(1, 0.5, 0.55, 'palm'))
    const waiting = p.bubbles.at(-1)!
    expect(waiting.pending).toBe(true)
    p.dive(1, 0)
    p.setText(waiting.id, 'Night swim', '🌙')
    p.dive(0, 0)
    expect(p.byId(waiting.id)).toMatchObject({ text: 'Night swim', pending: false })
    p.dive(1, 0)
    p.remove(waiting.id)
    p.dive(0, 0)
    expect(p.byId(waiting.id)).toBeUndefined()
  })

  it('keeps zones, axes and their undo with the area they were made in', () => {
    const p = new Play()
    p.applyStructure({ kind: 'zones', zones: ['Now', 'Later'], place: [] })
    expect(p.modes.zones).toBe(true)
    p.dive(1, 0)
    expect(p.modes.zones).toBe(false) // fresh space has no overlay
    expect(p.zoneRects).toEqual([])
    p.applyStructure({ kind: 'axes', x: ['cheap', 'dear'], y: ['dull', 'fun'], place: [] })
    frame(p, 0, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 400, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 433, hand(1, 0.5, 0.5, 'palm')) // something to keep the area for
    p.dive(0, 0)
    expect(p.modes).toMatchObject({ zones: true, axes: false })
    expect(p.labels.zones).toEqual(['Now', 'Later'])
    p.undo() // the organising, in this area
    expect(p.modes.zones).toBe(false)
    p.dive(1, 0)
    expect(p.modes.axes).toBe(true) // untouched by the other area's undo
    expect(p.labels.x).toEqual(['cheap', 'dear'])
  })

  it('forgets a kept area once its last bubble is taken back, and labels a kept line when the angle comes late', () => {
    const p = new Play()
    p.onRequest = () => {}
    p.dive(1, 0)
    frame(p, 0, hand(1, 0.5, 0.55, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.55, 'fist'))
    frame(p, 400, hand(1, 0.5, 0.55, 'fist'))
    frame(p, 433, hand(1, 0.5, 0.55, 'palm'))
    const only = p.bubbles[0]
    p.dive(0, 0)
    expect(p.find(only.id)?.id).toBe(only.id) // kept with its area
    p.remove(only.id) // nothing was heard
    p.setOverview(true)
    expect(p.cells()).toHaveLength(9) // no leftover empty area with a ring of its own
    p.setOverview(false)
    // An ask on a knot, then away before the LLM answers.
    const [a, b] = p.bubbles
    p.links.push([a.id, b.id])
    for (let t = 1000; t < 1600; t += 33) frame(p, t)
    const k = p.knot(a, b)
    frame(p, 2000, hand(1, k.x, k.y, 'victory'))
    frame(p, 2450, hand(1, k.x, k.y, 'victory'))
    frame(p, 2500)
    const made = p.bubbles.filter(v => v.knot).map(v => v.id)
    p.dive(0, 1)
    expect(p.find(made[0])?.pending).toBe(true) // still findable, so it can be filled or given up on
    p.setText(made[0], 'Both outdoors')
    p.setAngle(made, 'similarities')
    p.dive(0, 0)
    expect(p.linkWord(a.id, b.id)).toBe('similarities')
    expect(p.byId(made[0])?.full).toBe(`similarities: ${a.text} + ${b.text}`)
  })

  it('does not start a branch with the finger that chose the area, or organise by voice in the overview', () => {
    const p = new Play()
    const b = p.bubbles[0]
    p.dive(1, 0)
    p.dive(0, 0)
    p.setOverview(true)
    p.setStructuring(true)
    expect(p.structuring).toBe(false)
    const cell = p.cells().find(c => c.current)!
    // The finger rests on this area's tile, at a spot that is over a bubble once zoomed in.
    const overB = cell.x0 <= b.x && b.x < cell.x1 && cell.y0 <= b.y && b.y < cell.y1
    const fx = overB ? b.x : (cell.x0 + cell.x1) / 2, fy = overB ? b.y : (cell.y0 + cell.y1) / 2
    frame(p, 0, hand(1, fx, fy, 'point'))
    frame(p, DIVE_MS, hand(1, fx, fy, 'point'))
    expect(p.overview).toBe(false)
    for (let t = DIVE_MS + 100; t < DIVE_MS + 1500; t += 100) frame(p, t, hand(1, b.x, b.y, 'point'))
    expect(p.ideas.size).toBe(0) // the same finger, still pointing: no branch
    frame(p, 5000, hand(1, b.x, b.y, 'palm'))
    frame(p, 5100, hand(1, b.x, b.y, 'point'))
    frame(p, 5600, hand(1, b.x, b.y, 'point'))
    expect(p.ideas.has(1)).toBe(true) // lifted and pointed again: it works
  })

  it('names an area again only when its ideas have changed, and starts over on reset', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const asked = () => reqs.filter(r => r.kind === 'area').length
    p.setOverview(true)
    p.setAreaName('0,0', 'Days off')
    p.setOverview(false)
    p.setOverview(true)
    expect(asked()).toBe(1)
    expect(p.cells().find(c => c.current)!.name).toBe('Days off')
    p.setOverview(false)
    p.setText(p.bubbles[0].id, 'Sleep till noon')
    p.setOverview(true)
    expect(asked()).toBe(2)
    expect(p.cells().find(c => c.current)!.name).toBe('Days off') // the old name stays until the new one comes
    p.dive(1, 1)
    p.reset()
    expect(p.area).toEqual({ col: 0, row: 0 })
    expect(p.overview).toBe(false)
    p.setOverview(true)
    expect(p.cells()).toHaveLength(9)
  })

  it('limits suggestions and existing branches to the source zone, following moves and zone toggles', () => {
    const p = new Play()
    p.bounds = { x0: 0.1, x1: 0.9, y0: 0.1, y1: 0.9 }
    p.labels.zones = ['Now', 'Later']
    p.modes.zones = true
    const [source, local, remote, branch, pending, leaving] = p.bubbles
    p.bubbles = [source, local, remote, branch, pending, leaving]
    for (const [i, b] of p.bubbles.entries()) { b.x = i < 2 ? 0.3 : 0.7; b.y = 0.4 + i * 0.05 }
    source.y = 0.3
    local.y = remote.y = 0.8
    branch.y = 0.6
    branch.parent = source.id
    pending.x = leaving.x = 0.3
    pending.pending = true
    leaving.leaving = 'fling'
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const ask = (t: number) => {
      frame(p, t, hand(1, source.x, source.y, 'victory', t))
      frame(p, t + 450, hand(1, source.x, source.y, 'victory', t))
      frame(p, t + 480, hand(1, source.x, source.y, 'palm', t + 480))
      frame(p, t + 800, hand(1, source.x, source.y, 'palm', t + 480)) // the sign is down: the ask is sent
      return reqs.filter(r => r.kind === 'suggest').at(-1)!
    }
    expect(ask(0)).toMatchObject({ zone: 'Now', board: [local.text], branches: [] })
    source.x = 0.7
    expect(ask(1000)).toMatchObject({ zone: 'Later', board: [remote.text], branches: [branch.text] })
    p.modes.zones = false
    const unzoned = ask(2000)
    expect(unzoned).toMatchObject({ board: [local.text, remote.text], branches: [branch.text] })
    expect(unzoned).not.toHaveProperty('zone')
  })

  it('reworks using the source zone even when the new branch sprouts across its boundary', () => {
    const p = new Play()
    p.modes.zones = p.modes.workbench = true
    p.labels.zones = ['Now', 'Later']
    const [b, local, remote] = p.bubbles
    p.bubbles = [b, local, remote]
    b.x = 0.49; b.y = 0.5
    local.x = 0.2; local.y = 0.8
    remote.x = 0.8; remote.y = 0.8
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    frame(p, 0, hand(1, 0.49, 0.5, 'palm'), hand(2, 0.69, 0.5, 'palm'))
    frame(p, 33, hand(1, 0.49, 0.5, 'fist'), hand(2, 0.69, 0.5, 'palm'))
    frame(p, 66, hand(1, 0.49, 0.5, 'fist'), hand(2, 0.69, 0.5, 'fist'))
    frame(p, 99, hand(1, 0.49, 0.5, 'fist'), hand(2, 0.99, 0.5, 'fist'))
    frame(p, 132, hand(1, 0.49, 0.5, 'fist'), hand(2, 0.99, 0.5, 'palm'))
    expect(p.bubbles.at(-1)!.x).toBeGreaterThan(0.5)
    expect(reqs.at(-1)).toMatchObject({ kind: 'rework', how: 'further', idea: b.text, zone: 'Now', board: [local.text] })
  })

  it('listens for how to organise the board while both open hands are held high', () => {
    const p = new Play()
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const up = (t: number) => frame(p, t, hand(1, 0.3, 0.15, 'palm'), hand(2, 0.7, 0.15, 'none'))
    up(0); up(400)
    expect(p.structuring).toBe(false)
    up(750)
    expect(p.structuring).toBe(true)
    expect(reqs.at(-1)).toEqual({ kind: 'structureStart' })
    frame(p, 800, hand(1, 0.3, 0.15, 'palm')) // one hand drops out for a frame
    up(900)
    expect(p.structuring).toBe(true)
    frame(p, 1000, hand(1, 0.3, 0.7, 'palm'), hand(2, 0.7, 0.7, 'palm'))
    frame(p, 1400, hand(1, 0.3, 0.7, 'palm'), hand(2, 0.7, 0.7, 'palm'))
    expect(p.structuring).toBe(false)
    expect(reqs.at(-1)).toEqual({ kind: 'structureEnd' })
  })

  it('does not start listening for one raised hand, or while something is held', () => {
    const p = new Play()
    for (let t = 0; t < 2000; t += 100) frame(p, t, hand(1, 0.3, 0.15, 'palm'))
    expect(p.structuring).toBe(false)
    const b = p.bubbles[0]
    frame(p, 2000, hand(1, b.x, b.y, 'palm'), hand(2, 0.7, 0.15, 'palm'))
    frame(p, 2033, hand(1, b.x, b.y, 'fist'), hand(2, 0.7, 0.15, 'palm'))
    for (let t = 2100; t < 4000; t += 100) frame(p, t, hand(1, 0.3, 0.15, 'fist'), hand(2, 0.7, 0.15, 'palm'))
    expect(p.structuring).toBe(false)
  })

  it('organises the board as the LLM says: labels, overlay, bubbles gliding to place, undoable', () => {
    const p = new Play()
    const [a, b] = p.bubbles
    const before = { x: a.x, y: a.y }
    p.applyStructure({ kind: 'axes', x: ['cheap', 'costly'], y: ['dull', 'fun'], place: [{ id: a.id, x: 1, y: 1 }, { id: b.id, x: 0, y: 0 }, { id: 'ghost', x: 0.5, y: 0.5 }] })
    expect(p.modes.axes).toBe(true)
    expect(p.labels.x).toEqual(['cheap', 'costly'])
    for (let t = 0; t < 4000; t += 33) frame(p, t)
    expect(a.x).toBeGreaterThan(0.8) // high x: right
    expect(a.y).toBeLessThan(0.3) // high y: top
    expect(b.x).toBeLessThan(0.2)
    expect(b.y).toBeGreaterThan(0.7)

    p.applyStructure({ kind: 'zones', zones: ['Now', 'Never'], place: [{ id: a.id, zone: 0 }, { id: b.id, zone: 1 }] })
    expect(p.modes.zones).toBe(true)
    expect(p.modes.axes).toBe(false)
    for (let t = 4000; t < 8000; t += 33) frame(p, t)
    expect(a.x).toBeLessThan(0.5)
    expect(b.x).toBeGreaterThan(0.5)

    p.undo(); p.undo()
    const back = p.byId(a.id)!
    expect(back.x).toBeCloseTo(before.x)
    expect(back.y).toBeCloseTo(before.y)
  })

  it('does not make an idea out of a fist that closes and opens again quickly', () => {
    const p = new Play()
    const n = p.bubbles.length
    frame(p, 0, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 33, hand(1, 0.5, 0.5, 'fist'))
    frame(p, 200, hand(1, 0.5, 0.5, 'palm'))
    frame(p, 600, hand(1, 0.5, 0.5, 'palm'))
    expect(p.ideas.size).toBe(0)
    expect(p.bubbles).toHaveLength(n)
  })

  it('grabs the nearest bubble when a fist just misses it', () => {
    const p = new Play()
    const b = p.bubbles[0]
    b.scale = 0.5
    const justOff = b.y + 0.085 * 0.5 + 0.02 // a little below its rim
    frame(p, 0, hand(1, b.x, justOff, 'palm'))
    frame(p, 33, hand(1, b.x, justOff, 'fist'))
    expect(b.holders).toEqual([1])
    expect(p.aims.size).toBe(0)
  })

  it('lets a resting hand start nothing, though it can finish what it holds', () => {
    const p = new Play()
    const b = p.bubbles[0]
    const rest = (x: number, y: number, g: Gesture, since = 0): Hand => ({ ...hand(1, x, y, g, since), resting: true })
    frame(p, 0, rest(b.x, b.y, 'thumbDown'))
    frame(p, 1000, rest(b.x, b.y, 'thumbDown'))
    expect(b.leaving).toBeUndefined()
    frame(p, 1033, rest(0.5, 0.5, 'fist', 1033))
    frame(p, 1500, rest(0.5, 0.5, 'fist', 1033))
    expect(p.ideas.size).toBe(0)
    frame(p, 1533, rest(b.x, b.y, 'point', 1533))
    frame(p, 2100, rest(b.x, b.y, 'point', 1533))
    expect(p.ideas.size).toBe(0)
    // A hand that grabbed while active and then sags still lets go normally.
    frame(p, 2200, hand(1, b.x, b.y, 'palm'))
    frame(p, 2233, hand(1, b.x, b.y, 'fist'))
    frame(p, 2266, rest(b.x + 0.1, b.y, 'fist'))
    expect(b.x).toBeCloseTo(p.bubbles.at(-1)!.x)
    frame(p, 2300, rest(b.x + 0.1, b.y, 'palm'))
    expect(b.holders).toEqual([])
  })

  it('uses the body pose for raised hands when it is given, wherever the hands are on the board', () => {
    const p = new Play()
    const low = (t: number, raised: boolean) => p.update({ t, hands: [hand(1, 0.3, 0.6, 'palm'), hand(2, 0.7, 0.6, 'palm')], raised })
    low(0, true); low(400, true); low(800, true)
    expect(p.structuring).toBe(true)
    // While the board is listening, a fist starts nothing.
    p.update({ t: 900, hands: [hand(1, 0.3, 0.6, 'fist', 900), hand(2, 0.7, 0.6, 'palm')], raised: true })
    p.update({ t: 1400, hands: [hand(1, 0.3, 0.6, 'fist', 900), hand(2, 0.7, 0.6, 'palm')], raised: true })
    expect(p.ideas.size).toBe(0)
    low(1500, false); low(1900, false)
    expect(p.structuring).toBe(false)
  })

  it('picks a bubble up with a fist at the middle of the hand, wherever the fingertip is', () => {
    const p = new Play()
    const b = p.bubbles[0]
    // The fingertip is off the bubble; the middle of the hand is on it.
    const fist = (x: number, y: number): Hand => ({ ...hand(1, x, y, 'fist'), tipX: x + 0.3, tipY: y + 0.3 })
    frame(p, 0, hand(1, b.x, b.y, 'palm'))
    frame(p, 33, fist(b.x, b.y))
    expect(b.holders).toEqual([1])
    frame(p, 66, fist(b.x + 0.1, b.y + 0.1))
    expect(p.bubbles.at(-1)!.x).toBeCloseTo(0.14 + 0.1)
    frame(p, 99, hand(1, b.x, b.y, 'palm'))
    expect(b.holders).toEqual([])
  })

  it('lands a new idea small when set down gently and big when thrown down', () => {
    const place = (speed: number) => {
      const p = new Play()
      frame(p, 0, hand(1, 0.5, 0.5, 'palm'))
      frame(p, 33, hand(1, 0.5, 0.5, 'fist'))
      frame(p, 400, hand(1, 0.5, 0.5, 'fist'))
      frame(p, 433, hand(1, 0.5, 0.5, 'palm', 433, speed, 0))
      return p.bubbles.at(-1)!.scale
    }
    expect(place(0)).toBeCloseTo(0.8)
    expect(place(2)).toBeCloseTo(1.5)
    expect(place(0.6)).toBeGreaterThan(place(0.2))
  })

  it('keeps every bubble within reach when the reachable area is smaller than the board', () => {
    const p = new Play()
    p.bounds = { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }
    for (let t = 0; t < 3000; t += 33) frame(p, t)
    expect(p.bubbles.every(b => b.x >= 0.19 && b.x <= 0.81 && b.y >= 0.19 && b.y <= 0.81)).toBe(true)
    p.reset()
    expect(p.bubbles.every(b => b.x >= 0.2 && b.x <= 0.8)).toBe(true) // the examples are laid out inside it
    p.applyStructure({ kind: 'axes', x: ['a', 'b'], y: ['c', 'd'], place: [{ id: p.bubbles[0].id, x: 1, y: 1 }] })
    expect(p.bubbles[0].goal!.x).toBeLessThan(0.8)
  })

  it('pushes overlapping bubbles apart and keeps them on the board', () => {
    const p = new Play()
    const [a, b] = p.bubbles
    b.x = a.x + 0.01
    b.y = a.y
    a.x = 0
    for (let t = 0; t < 3000; t += 33) frame(p, t)
    expect(Math.hypot((a.x - b.x) * p.aspect, a.y - b.y)).toBeGreaterThan(0.15)
    expect(a.x).toBeGreaterThan(0.04)
  })
})


describe('a fist that is not an idea', () => {
  const fresh = () => { const p = new Play(); p.empty(); return p }

  it('waits much longer on a hand that came into view already closed', () => {
    const p = fresh()
    p.update({ t: 0, hands: [hand(2, 0.2, 0.45, 'fist')] })
    p.update({ t: IDEA_DWELL_MS + 200, hands: [hand(2, 0.2, 0.45, 'fist')] })
    expect(p.ideas.size).toBe(0)
    p.update({ t: IDEA_ARRIVED_MS + 10, hands: [hand(2, 0.2, 0.45, 'fist')] })
    expect(p.ideas.size).toBe(1)
  })

  it('starts nothing below the board, where a hand is being lowered', () => {
    const p = fresh()
    p.bounds = { x0: 0.06, y0: 0.06, x1: 0.94, y1: 0.94 }
    p.update({ t: 0, hands: [hand(2, 0.2, 0.6, 'palm')] })
    p.update({ t: 33, hands: [hand(2, 0.2, 0.7, 'fist', 33)] })
    p.update({ t: 500, hands: [hand(2, 0.16, 1.01, 'fist', 33)] })
    expect(p.ideas.size).toBe(0)
  })
})

describe('an idea whose hand never opens', () => {
  const start = () => {
    const p = new Play()
    p.empty()
    const events: [string, Record<string, unknown>][] = []
    p.onEvent = (type, data) => events.push([type, data])
    p.update({ t: 0, hands: [hand(1, 0.4, 0.4, 'palm')] })
    p.update({ t: 33, hands: [hand(1, 0.4, 0.4, 'fist', 33)] })
    p.update({ t: 500, hands: [hand(1, 0.4, 0.4, 'fist', 33)] })
    expect(p.ideas.size).toBe(1)
    return { p, events, since: 500 }
  }

  it('is put down where it was when the camera loses the hand after a moment, as when an arm is lowered', () => {
    const { p, events, since } = start()
    p.update({ t: since + IDEA_KEEP_MS, hands: [hand(1, 0.45, 0.5, 'fist', 33)] })
    p.update({ t: since + IDEA_KEEP_MS + 33, hands: [] })
    expect(events.at(-1)![0]).toBe('ideaPlaced')
    expect(p.bubbles).toHaveLength(1)
    expect(p.bubbles[0].x).toBeCloseTo(0.45)
  })

  it('is dropped when the hand is lost straight away: that was a flicker, not an idea', () => {
    const { p, events, since } = start()
    p.update({ t: since + 200, hands: [] })
    expect(events.at(-1)).toEqual(['ideaAbandoned', expect.objectContaining({ why: 'hand lost' })])
    expect(p.bubbles).toHaveLength(0)
  })

  it('is let go when it is held so long that it is talk, and the still-closed fist starts no other', () => {
    const { p, events, since } = start()
    p.update({ t: since + IDEA_MAX_MS, hands: [hand(1, 0.4, 0.4, 'fist', 33)] })
    expect(events.at(-1)).toEqual(['ideaAbandoned', expect.objectContaining({ why: 'too long' })])
    p.update({ t: since + IDEA_MAX_MS + 2000, hands: [hand(1, 0.4, 0.4, 'fist', 33)] })
    expect(p.ideas.size).toBe(0)
    expect(p.bubbles).toHaveLength(0)
  })
})


describe('a pointed-out idea that lands on another bubble', () => {
  const land = (spoke: boolean) => {
    const p = new Play()
    const events: string[] = []
    p.onEvent = type => events.push(type)
    const [a, b] = p.bubbles
    const n = p.bubbles.length
    const f = (t: number, x: number, y: number, g: Gesture) => p.update({ t, hands: [hand(1, x, y, g)] })
    f(0, a.x, a.y, 'point')
    f(410, a.x, a.y, 'point')
    if (spoke) p.heard = new Set([1])
    f(450, b.x, b.y, 'point')
    f(500, b.x, b.y, 'palm')
    return { events, added: p.bubbles.length - n }
  }

  it('connects the two when nothing was said', () => {
    const { events, added } = land(false)
    expect(events).toContain('connect')
    expect(added).toBe(0)
  })

  // The fingertip stops `gap` bubble radii outside the other bubble's rim, on the side away from the first.
  const stopShort = (gap: number, spoke: boolean) => {
    const p = new Play()
    const events: [string, Record<string, unknown>][] = []
    p.onEvent = (type, data) => events.push([type, data as Record<string, unknown>])
    const [a, b] = p.bubbles
    const n = p.bubbles.length
    const d = Math.hypot((b.x - a.x) * p.aspect, b.y - a.y)
    const k = 1 + (R * b.scale + R * gap) / d
    const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k
    const f = (t: number, x: number, y: number, g: Gesture) => p.update({ t, hands: [hand(1, x, y, g)] })
    f(0, a.x, a.y, 'point')
    f(410, a.x, a.y, 'point')
    if (spoke) p.heard = new Set([1])
    f(450, x, y, 'point')
    f(500, x, y, 'palm')
    return { events, types: events.map(e => e[0]), added: p.bubbles.length - n, b }
  }

  it('connects when a silent fingertip stops just short of the other bubble', () => {
    const { types, added, events, b } = stopShort(0.5, false)
    expect(types).toContain('connect')
    expect(added).toBe(0)
    expect(events.find(e => e[0] === 'branchEnd')![1]).toMatchObject({ near: b.id, spoke: false, over: undefined })
  })

  it('plants the idea when the fingertip stops well clear of every bubble', () => {
    const { types, added } = stopShort(1.5, false)
    expect(types).not.toContain('connect')
    expect(added).toBe(1)
  })

  it('plants a spoken idea that stops just short of another bubble', () => {
    const { types, added } = stopShort(0.5, true)
    expect(types).not.toContain('connect')
    expect(added).toBe(1)
  })

  it('stays an idea when it was being spoken: the fingertip only drifted there', () => {
    const { events, added } = land(true)
    expect(events).not.toContain('connect')
    expect(events.at(-1)).toBe('ideaPlaced')
    expect(added).toBe(1)
  })
})
