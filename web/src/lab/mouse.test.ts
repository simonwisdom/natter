import { describe, expect, it } from 'vitest'
import { MOUSE_HAND, MouseHand, pressGesture } from './mouse'
import { IDEA_DWELL_MS, Play } from './play'
import { ZoneEditor } from './zones'

const LEFT = { button: 0, shiftKey: false, altKey: false, ctrlKey: false }

/** Run the board with only the mouse hand, a frame every 33 ms, until time `to`. */
function run(p: Play, m: MouseHand, clock: { t: number }, to: number) {
  for (; clock.t <= to; clock.t += 33) {
    const h = m.hand(clock.t)
    p.update({ t: clock.t, hands: h ? [h] : [] })
  }
}

describe('pressGesture', () => {
  it('maps buttons and modifier keys to hand shapes', () => {
    expect(pressGesture(LEFT)).toBe('fist')
    expect(pressGesture({ ...LEFT, button: 2 })).toBe('point')
    expect(pressGesture({ ...LEFT, shiftKey: true })).toBe('point')
    expect(pressGesture({ ...LEFT, ctrlKey: true })).toBe('point')
    expect(pressGesture({ ...LEFT, altKey: true })).toBe('victory')
    expect(pressGesture({ ...LEFT, button: 1 })).toBe('victory')
  })
})

describe('MouseHand', () => {
  it('appears open when the mouse moves and goes once it has been still, unless something is held', () => {
    const m = new MouseHand()
    expect(m.hand(0)).toBeUndefined()
    m.move(0.4, 0.5, 100)
    expect(m.hand(100)).toMatchObject({ id: MOUSE_HAND, x: 0.4, y: 0.5, gesture: 'palm' })
    expect(m.hand(2500)).toBeDefined()
    expect(m.hand(2700)).toBeUndefined()
    m.press('fist', 0.4, 0.5, 3000)
    m.hand(3000)
    expect(m.hand(9000)?.gesture).toBe('fist')
  })

  it('is seen open for one frame before a press that arrives with no movement first', () => {
    const m = new MouseHand()
    m.press('fist', 0.5, 0.5, 0)
    expect(m.hand(0)?.gesture).toBe('palm')
    expect(m.hand(33)).toMatchObject({ gesture: 'fist', gestureSince: 33 })
    m.release(66)
    expect(m.hand(66)?.gesture).toBe('palm')
  })

  it('holds a thumb long enough to count, then opens again', () => {
    const m = new MouseHand()
    m.move(0.5, 0.5, 0)
    m.hand(0)
    m.thumb(false, 33)
    expect(m.hand(33)?.gesture).toBe('thumbDown')
    expect(m.hand(700)).toMatchObject({ gesture: 'thumbDown', gestureSince: 33 })
    expect(m.hand(800)?.gesture).toBe('palm')
  })

  it('reports how fast it is moving, and that it has stopped', () => {
    const m = new MouseHand()
    m.move(0.2, 0.5, 0)
    m.move(0.3, 0.5, 50)
    m.move(0.4, 0.5, 100)
    expect(m.hand(100)!.vx).toBeGreaterThan(1)
    expect(m.hand(300)!.vx).toBe(0)
  })
})

describe('the mouse on the board', () => {
  it('drags a bubble and drops it where the button is let go', () => {
    const p = new Play(), m = new MouseHand(), clock = { t: 0 }
    const b = p.bubbles[0]
    m.move(b.x, b.y, 0)
    run(p, m, clock, 100)
    m.press('fist', b.x, b.y, clock.t)
    run(p, m, clock, 300)
    expect(b.holders).toEqual([MOUSE_HAND])
    m.move(0.5, 0.9, clock.t)
    run(p, m, clock, 600)
    m.release(clock.t)
    run(p, m, clock, 800)
    expect(b.holders).toEqual([])
    expect(b.x).toBeCloseTo(0.5, 1)
    expect(b.y).toBeCloseTo(0.9, 1)
  })

  it('makes a new idea from a press held on empty space, placed on release', () => {
    const p = new Play(), m = new MouseHand(), clock = { t: 0 }
    p.empty()
    m.move(0.5, 0.5, 0)
    run(p, m, clock, 100)
    m.press('fist', 0.5, 0.5, clock.t)
    run(p, m, clock, clock.t + IDEA_DWELL_MS + 200)
    expect(p.ideas.has(MOUSE_HAND)).toBe(true)
    m.release(clock.t)
    run(p, m, clock, clock.t + 200)
    expect(p.ideas.size).toBe(0)
    expect(p.bubbles.length).toBe(1)
  })

  it('bins the bubble under the pointer on a thumbs-down key', () => {
    const p = new Play(), m = new MouseHand(), clock = { t: 0 }
    const b = p.bubbles[0], before = p.bubbles.filter(k => !k.leaving).length
    m.move(b.x, b.y, 0)
    run(p, m, clock, 100)
    m.thumb(false, clock.t)
    run(p, m, clock, clock.t + 900)
    expect(p.bubbles.filter(k => !k.leaving).length).toBe(before - 1)
  })

  it('draws a zone by dragging in Draw zones', () => {
    const z = new ZoneEditor(), m = new MouseHand()
    z.setEditing(true)
    let t = 0
    const frame = () => { const h = m.hand(t); z.update(h ? [h] : [], t); t += 33 }
    m.move(0.1, 0.1, t); frame()
    m.press('fist', 0.1, 0.1, t); frame(); frame()
    m.move(0.5, 0.6, t); frame()
    m.release(t); frame()
    expect(z.zones).toHaveLength(1)
    expect(z.zones[0]).toMatchObject({ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.6 })
  })
})
