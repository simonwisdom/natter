import { describe, expect, it } from 'vitest'
import type { Landmark } from '../input/people'
import { margin, type Gesture, type Hand } from './body'
import { atMouth, micHands, readBodies, whose } from './people'
import { Play, type PlayRequest } from './play'

const ASPECT = 16 / 9

/** A camera point that lands on board position (x, y). */
const cam = (x: number, y: number): Landmark => ({ x: 1 - (x * (1 - 2 * margin) + margin), y: y * (1 - 2 * margin) + margin, visibility: 1 })

/** Someone standing at `x` across the board, shoulders at height 0.4, wrists out to each side unless given. */
function body(x: number, wrists: [number, number][] = [[x - 0.1, 0.6], [x + 0.1, 0.6]]): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  lm[0] = cam(x, 0.28)
  lm[9] = cam(x - 0.01, 0.31)
  lm[10] = cam(x + 0.01, 0.31)
  lm[11] = cam(x - 0.06, 0.4)
  lm[12] = cam(x + 0.06, 0.4)
  lm[15] = cam(...wrists[0])
  lm[16] = cam(...wrists[1])
  return lm
}

function hand(id: number, x: number, y: number, gesture: Gesture = 'palm', person?: number): Hand {
  return { id, x, y, tipX: x, tipY: y, vx: 0, vy: 0, gesture, gestureSince: 0, score: 1, landmarks: [], raw: gesture, label: '', fingers: [], person }
}

const place = (bodies: Landmark[][], hands: Hand[], known = new Map<number, number>()) => whose(readBodies(bodies, ASPECT), hands, known, ASPECT)

describe('whose hand is whose', () => {
  it('gives the person on the left of the screen the first microphone and the one on the right the second', () => {
    const got = place([body(0.75), body(0.25)], [hand(1, 0.85, 0.6), hand(2, 0.15, 0.6), hand(3, 0.35, 0.6)])
    expect([...got]).toEqual([[1, 1], [2, 0], [3, 0]])
  })

  it('keeps a hand with its person while the other person drops out of the picture', () => {
    const both = place([body(0.25), body(0.75)], [hand(1, 0.85, 0.6)])
    expect(both.get(1)).toBe(1)
    // Only the left person is found now, and the hand has drifted towards them.
    expect(place([body(0.25)], [hand(1, 0.6, 0.6)], both).get(1)).toBe(1)
  })

  it('keeps both hands of someone alone together, whichever half of the screen they stand in', () => {
    const first = place([body(0.55)], [hand(1, 0.65, 0.6)])
    expect(first.get(1)).toBe(1)
    // They step across the middle and bring up the other hand: it joins the first.
    const then = place([body(0.45)], [hand(1, 0.55, 0.6), hand(2, 0.35, 0.6)], first)
    expect([...then]).toEqual([[1, 1], [2, 1]])
  })

  it('counts one person found twice as one', () => {
    const bodies = readBodies([body(0.5), body(0.52)], ASPECT)
    expect(bodies).toHaveLength(1)
    const got = whose(bodies, [hand(1, 0.4, 0.6), hand(2, 0.6, 0.6)], new Map(), ASPECT)
    expect(got.get(1)).toBe(got.get(2))
  })

  it('gives a new hand far from the only body found to the other person', () => {
    // The right person's body isn't found for a moment, and their hand comes back as a new one.
    const got = place([body(0.25)], [hand(1, 0.15, 0.6), hand(7, 0.85, 0.6)], new Map([[1, 0]]))
    expect([...got]).toEqual([[1, 0], [7, 1]])
  })

  it('puts the hands of someone alone back together after a body seen double split them', () => {
    const got = place([body(0.5)], [hand(1, 0.4, 0.6), hand(2, 0.6, 0.6)], new Map([[1, 0], [2, 1]]))
    expect(got.get(1)).toBe(got.get(2))
  })

  it('leaves a hand unplaced when nobody is in shot', () => {
    expect(place([], [hand(1, 0.5, 0.5)]).size).toBe(0)
  })

  it('reads a hand at the mouth as holding a microphone, and one at the chest or out to the side as not', () => {
    const bodies = readBodies([body(0.5)], ASPECT)
    expect(atMouth(bodies, { x: 0.52, y: 0.36 }, ASPECT)).toBe(true)
    expect(atMouth(bodies, { x: 0.5, y: 0.55 }, ASPECT)).toBe(false)
    expect(atMouth(bodies, { x: 0.7, y: 0.35 }, ASPECT)).toBe(false)
  })
})

describe('a hand holding a microphone', () => {
  const bodies = readBodies([body(0.5)], ASPECT)
  const held = (hands: Hand[], was: number[] = []) => [...micHands(bodies, hands, new Set(was), ASPECT)]

  it('is one once it has been at the mouth, and stays one when lowered to the chest', () => {
    expect(held([hand(1, 0.52, 0.36, 'fist'), hand(2, 0.3, 0.6, 'fist')])).toEqual([1])
    expect(held([hand(1, 0.5, 0.55, 'fist'), hand(2, 0.3, 0.6, 'fist')], [1])).toEqual([1])
  })

  it('is not one if it was never at the mouth', () => {
    expect(held([hand(1, 0.5, 0.55, 'fist')])).toEqual([])
  })

  it('stops being one when it opens flat or is lost', () => {
    expect(held([hand(1, 0.5, 0.55, 'palm')], [1])).toEqual([])
    expect(held([hand(2, 0.3, 0.6, 'fist')], [1])).toEqual([])
  })
})

describe('two people at the board', () => {
  const frame = (p: Play, t: number, ...hands: Hand[]) => p.update({ t, hands })
  const listening = (reqs: PlayRequest[]) => reqs.filter(r => r.kind === 'listenStart').map(r => (r as { hand: number }).hand)

  it('lets each person say an idea at the same time when each has a microphone', () => {
    const p = new Play()
    p.empty()
    p.voices = 2
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    const both = (t: number, g: Gesture) => frame(p, t, hand(1, 0.3, 0.5, g, 0), hand(2, 0.7, 0.5, g, 1))
    both(0, 'palm')
    both(33, 'fist')
    expect(p.canvasHold).toBeUndefined() // two people's fists are not one person's two-handed hold
    both(500, 'fist')
    expect(p.ideas.size).toBe(2)
    expect(listening(reqs)).toEqual([1, 2])
  })

  it('still takes one idea at a time when they share a microphone, or when both hands are one person’s', () => {
    for (const [voices, other] of [[1, 1], [2, 0]]) {
      const p = new Play()
      p.empty()
      p.voices = voices
      const reqs: PlayRequest[] = []
      p.onRequest = r => reqs.push(r)
      frame(p, 0, hand(1, 0.3, 0.5, 'palm', 0), hand(2, 0.7, 0.5, 'palm', other))
      frame(p, 33, hand(1, 0.3, 0.5, 'fist', 0), hand(2, 0.7, 0.5, 'palm', other))
      frame(p, 1000, hand(1, 0.3, 0.5, 'fist', 0), hand(2, 0.7, 0.5, 'fist', other))
      frame(p, 2000, hand(1, 0.3, 0.5, 'fist', 0), hand(2, 0.7, 0.5, 'fist', other))
      expect(listening(reqs)).toEqual([1])
    }
  })

  it('holds the canvas with one person’s two fists, as before', () => {
    const p = new Play()
    p.empty()
    frame(p, 0, hand(1, 0.3, 0.5, 'palm', 1), hand(2, 0.6, 0.5, 'palm', 1), hand(3, 0.9, 0.5, 'palm', 0))
    frame(p, 33, hand(1, 0.3, 0.5, 'fist', 1), hand(2, 0.6, 0.5, 'fist', 1), hand(3, 0.9, 0.5, 'fist', 0))
    expect(p.canvasHold?.hands).toEqual([1, 2])
  })

  it('does not let another person’s fist resize the bubble someone is holding', () => {
    const p = new Play()
    const b = p.bubbles[0]
    const { x, y } = b
    frame(p, 0, hand(1, x, y, 'palm', 0), hand(2, x + 0.2, y + 0.5, 'palm', 1))
    frame(p, 33, hand(1, x, y, 'fist', 0), hand(2, x + 0.2, y + 0.5, 'palm', 1))
    frame(p, 66, hand(1, x, y, 'fist', 0), hand(2, x + 0.2, y + 0.5, 'fist', 1))
    frame(p, 99, hand(1, x, y, 'fist', 0), hand(2, x + 0.4, y + 0.5, 'fist', 1))
    expect(b.holders).toEqual([1])
    expect(b.scale).toBe(1)
  })

  it('does not let another person take hold of a bubble someone is holding, or start an idea on top of it', () => {
    const p = new Play()
    const b = p.bubbles[0]
    const { x, y } = b
    frame(p, 0, hand(1, x, y, 'palm', 0), hand(2, x + 0.01, y, 'palm', 1))
    frame(p, 33, hand(1, x, y, 'fist', 0), hand(2, x + 0.01, y, 'palm', 1))
    frame(p, 66, hand(1, x, y, 'fist', 0), hand(2, x + 0.01, y, 'fist', 1))
    frame(p, 1000, hand(1, x, y, 'fist', 0), hand(2, x + 0.01, y, 'fist', 1))
    expect(b.holders).toEqual([1])
    expect(p.ideas.size).toBe(0)
  })
})
