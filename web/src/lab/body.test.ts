import { describe, expect, it } from 'vitest'
import { HandTracker, margin, readGesture, type Gesture, type RawHand } from './body'

const CURLED = [0.8, 0.8, 0.8, 0.8]
const HALF = [1.15, 1.15, 1.15, 1.15]
const STRAIGHT = [1.5, 1.5, 1.5, 1.5]

/** A camera hand in the middle of the board, as the camera code hands it over: the classifier's word plus finger measurements. */
function raw(base: Gesture, fingers: number[]): RawHand {
  const cam = { x: 0.5, y: 0.5 * (1 - 2 * margin) + margin }
  return { landmarks: Array.from({ length: 21 }, () => cam), gesture: readGesture(base, fingers), base, score: 1, fingers }
}

/** Feed the same reading for `frames` camera frames (33 ms each) and return what the hand ends up as. */
function hold(tr: HandTracker, clock: { t: number }, frames: number, h: () => RawHand): Gesture | undefined {
  let g: Gesture | undefined
  for (let i = 0; i < frames; i++) g = tr.update([h()], (clock.t += 33))[0]?.gesture
  return g
}

describe('readGesture', () => {
  it('reads a lone frame as before', () => {
    expect(readGesture('none', [1.4, 0.9, 0.9, 0.9])).toBe('point')
    expect(readGesture('none', [1.4, 1.4, 0.9, 0.9])).toBe('victory')
    expect(readGesture('none', STRAIGHT)).toBe('palm')
    expect(readGesture('fist', CURLED)).toBe('fist')
    expect(readGesture('thumbUp', [1.4, 0.9, 0.9, 0.9])).toBe('thumbUp')
  })

  it('does not start a gesture from a borderline reading', () => {
    expect(readGesture('none', [1.15, 0.9, 0.9, 0.9])).toBe('none') // not quite a point
    expect(readGesture('none', HALF)).toBe('none') // not quite open
    expect(readGesture('none', CURLED)).toBe('none') // only the classifier starts a fist
    expect(readGesture('none', CURLED, 'palm')).toBe('none')
  })

  it('keeps the last reading through a borderline one', () => {
    expect(readGesture('none', [1.15, 1.1, 0.9, 0.9], 'point')).toBe('point')
    expect(readGesture('none', [1.15, 1.15, 1.1, 0.9], 'victory')).toBe('victory')
    expect(readGesture('none', HALF, 'palm')).toBe('palm')
    expect(readGesture('none', CURLED, 'fist')).toBe('fist')
  })

  it('lets go once the hand clearly changes', () => {
    expect(readGesture('none', [1.0, 0.9, 0.9, 0.9], 'point')).toBe('none')
    expect(readGesture('none', [1.0, 1.0, 1.0, 1.0], 'palm')).toBe('none')
    expect(readGesture('none', HALF, 'fist')).toBe('none')
    expect(readGesture('none', STRAIGHT, 'fist')).toBe('palm')
  })
})

describe('HandTracker with finger measurements', () => {
  it('keeps a fist the classifier stops naming, for as long as the fingers stay curled', () => {
    const tr = new HandTracker(), clock = { t: 0 }
    expect(hold(tr, clock, 8, () => raw('fist', CURLED))).toBe('fist')
    // Far longer than the 160 ms let-go delay.
    expect(hold(tr, clock, 30, () => raw('none', CURLED))).toBe('fist')
    expect(hold(tr, clock, 10, () => raw('none', STRAIGHT))).toBe('palm')
  })

  it('never starts a fist from the curled fingers that keep one', () => {
    const tr = new HandTracker(), clock = { t: 0 }
    expect(hold(tr, clock, 30, () => raw('none', CURLED))).toBe('none')
  })

  it('reads thumb and fingertip together as nothing: there is no pinch', () => {
    const tr = new HandTracker(), clock = { t: 0 }
    expect(hold(tr, clock, 30, () => raw('none', [1.1, 1.3, 1.3, 1.3]))).toBe('none')
  })

  it('reads an open hand steadily when one finger jitters across the cut-off', () => {
    const tr = new HandTracker(), clock = { t: 0 }
    hold(tr, clock, 8, () => raw('none', STRAIGHT))
    const seen = new Set<Gesture | undefined>()
    for (let i = 0; i < 40; i++) {
      // Alternate frames in pairs so each reading lasts long enough to get past the time delay alone.
      const wobble = Math.floor(i / 4) % 2 ? 1.18 : 1.32
      for (const h of tr.update([raw('none', [1.5, 1.5, 1.5, wobble])], (clock.t += 33))) seen.add(h.raw)
    }
    expect([...seen]).toEqual(['palm'])
  })
})
