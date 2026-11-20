import { describe, expect, it } from 'vitest'
import type { Gesture, Hand } from './body'
import { BURN_MS, BURN_OUT_MS, DELETE_IDLE_MS, Play } from './play'
import { Shake, SWING } from './shake'
import { PRESS_MS, Rail, type RailButton } from './rail'
import { ZoneEditor } from './zones'

function hand(id: number, x: number, y: number, gesture: Gesture, resting = false): Hand {
  return { id, x, y, tipX: x, tipY: y, vx: 0, vy: 0, gesture, gestureSince: 0, score: 1, landmarks: [], raw: gesture, label: '', fingers: [], resting }
}
const BUTTONS: RailButton[] = [
  { id: 'delete-mode', x0: 0.85, x1: 0.98, y0: 0.3, y1: 0.4 },
  { id: 'draw-zones', x0: 0.85, x1: 0.98, y0: 0.45, y1: 0.55 },
]

describe('Rail', () => {
  it('presses a button once when a pointing finger has rested on it, and again only after it moves off', () => {
    const r = new Rail()
    expect(r.update(BUTTONS, [hand(1, 0.9, 0.35, 'point')], 0)).toBeUndefined()
    expect(r.aim).toMatchObject({ id: 'delete-mode', since: 0 })
    expect(r.update(BUTTONS, [hand(1, 0.9, 0.35, 'point')], PRESS_MS - 1)).toBeUndefined()
    expect(r.update(BUTTONS, [hand(1, 0.9, 0.35, 'point')], PRESS_MS)).toBe('delete-mode')
    expect(r.holds(1)).toBe(true)
    expect(r.update(BUTTONS, [hand(1, 0.9, 0.35, 'point')], PRESS_MS * 3)).toBeUndefined()
    r.update(BUTTONS, [hand(1, 0.5, 0.5, 'point')], PRESS_MS * 3 + 33)
    expect(r.holds(1)).toBe(false)
    r.update(BUTTONS, [hand(1, 0.9, 0.35, 'point')], 5000)
    expect(r.update(BUTTONS, [hand(1, 0.9, 0.35, 'point')], 5000 + PRESS_MS)).toBe('delete-mode')
  })

  it('starts again when the finger slides to another button or stops pointing', () => {
    const r = new Rail()
    r.update(BUTTONS, [hand(1, 0.9, 0.35, 'point')], 0)
    r.update(BUTTONS, [hand(1, 0.9, 0.5, 'point')], 500)
    expect(r.aim).toMatchObject({ id: 'draw-zones', since: 500 })
    expect(r.update(BUTTONS, [hand(1, 0.9, 0.5, 'point')], PRESS_MS)).toBeUndefined()
    r.update(BUTTONS, [hand(1, 0.9, 0.5, 'palm')], PRESS_MS + 33)
    expect(r.aim).toBeUndefined()
    expect(r.update(BUTTONS, [hand(1, 0.9, 0.5, 'point')], 500 + PRESS_MS + 100)).toBeUndefined()
  })

  it('ignores open hands, fists and resting hands on a button', () => {
    const r = new Rail()
    for (const h of [hand(1, 0.9, 0.35, 'palm'), hand(1, 0.9, 0.35, 'fist'), hand(1, 0.9, 0.35, 'point', true)]) {
      r.update(BUTTONS, [h], 0)
      expect(r.update(BUTTONS, [h], PRESS_MS * 2)).toBeUndefined()
      expect(r.aim).toBeUndefined()
    }
  })
})

describe('delete mode', () => {
  const live = (p: Play) => p.bubbles.filter(b => !b.leaving).length

  it('bins the bubble a pointing finger rests on, one rest at a time, and undo brings it back', () => {
    const p = new Play()
    const n = live(p), a = p.bubbles[0], b = p.bubbles[1]
    p.setDeleting(true)
    p.update({ t: 0, hands: [hand(1, a.x, a.y, 'point')] })
    expect(p.aims.get(1)).toMatchObject({ bubble: a.id, kind: 'burn' })
    p.update({ t: BURN_MS - 1, hands: [hand(1, a.x, a.y, 'point')] })
    expect(live(p)).toBe(n)
    p.update({ t: BURN_MS, hands: [hand(1, a.x, a.y, 'point')] })
    expect(a.leaving).toBe('burn')
    // Sliding straight onto the next bubble starts its own count.
    p.update({ t: BURN_MS + 33, hands: [hand(1, b.x, b.y, 'point')] })
    p.update({ t: BURN_MS + 200, hands: [hand(1, b.x, b.y, 'point')] })
    expect(b.leaving).toBeUndefined()
    p.update({ t: BURN_MS * 2 + 33, hands: [hand(1, b.x, b.y, 'point')] })
    expect(b.leaving).toBe('burn')
    expect(live(p)).toBe(n - 2)
    p.undo()
    expect(live(p)).toBe(n - 1)
  })

  it('does nothing else: no grab, no new idea, no branch, no thumbs', () => {
    const p = new Play()
    const n = live(p), a = p.bubbles[0]
    p.setDeleting(true)
    let t = 0
    for (const g of ['fist', 'palm', 'victory', 'thumbDown', 'thumbUp'] as Gesture[]) {
      p.update({ t: (t += 33), hands: [hand(1, a.x, a.y, 'palm')] })
      for (const end = t + 1200; t < end; t += 33) p.update({ t, hands: [hand(1, a.x, a.y, g)] })
      for (const end = t + 1200; t < end; t += 33) p.update({ t, hands: [hand(1, 0.5, 0.95, g)] })
    }
    expect(p.deleting).toBe(true)
    expect(live(p)).toBe(n)
    expect(p.ideas.size).toBe(0)
    expect(a.holders).toEqual([])
    expect(a.starred).toBeFalsy()
  })

  it('lets go of whatever was held on the way in, and switches itself off when nothing is binned for a while', () => {
    const p = new Play()
    const a = p.bubbles[0]
    p.update({ t: 0, hands: [hand(1, a.x, a.y, 'palm')] })
    p.update({ t: 33, hands: [hand(1, a.x, a.y, 'fist')] })
    expect(a.holders).toEqual([1])
    p.setDeleting(true)
    expect(a.holders).toEqual([])
    p.update({ t: 100, hands: [] })
    p.update({ t: 33 + DELETE_IDLE_MS - 1, hands: [] })
    expect(p.deleting).toBe(true)
    p.update({ t: 33 + DELETE_IDLE_MS, hands: [] })
    expect(p.deleting).toBe(false)
  })

  it('burns a deleted bubble where it stands, then takes it off the board', () => {
    const p = new Play()
    const a = p.bubbles[0], at = { x: a.x, y: a.y }
    p.setDeleting(true)
    p.update({ t: 0, hands: [hand(1, a.x, a.y, 'point')] })
    p.update({ t: BURN_MS, hands: [hand(1, a.x, a.y, 'point')] })
    p.update({ t: BURN_MS + BURN_OUT_MS - 50, hands: [] })
    expect(p.bubbles).toContain(a)
    expect({ x: a.x, y: a.y }).toEqual(at)
    p.update({ t: BURN_MS + BURN_OUT_MS, hands: [] })
    expect(p.bubbles).not.toContain(a)
  })

  it('does not burn a bubble a fast-moving finger is passing over', () => {
    const p = new Play()
    const a = p.bubbles[0]
    p.setDeleting(true)
    for (let t = 0; t <= BURN_MS * 3; t += 33) p.update({ t, hands: [{ ...hand(1, a.x, a.y, 'point'), vx: 1.2 }] })
    expect(a.leaving).toBeUndefined()
  })

  it('is put out by shaking a finger from side to side, without burning what it shakes over', () => {
    const p = new Play()
    const a = p.bubbles[0]
    p.setDeleting(true)
    let t = 0
    // Wag across the bubble: 4 cm each way, five times a second.
    for (let i = 0; i < 12 && p.deleting; i++) {
      const x = a.x + (i % 2 ? 0.04 : -0.04)
      p.update({ t: (t += 100), hands: [{ ...hand(1, x, a.y, 'point'), vx: i % 2 ? 0.8 : -0.8 }] })
    }
    expect(p.deleting).toBe(false)
    expect(p.deleteEnded).toBe('shake')
    expect(a.leaving).toBeUndefined()
  })

  it('and drawing zones turn each other off', () => {
    const p = new Play()
    p.setDeleting(true)
    p.setDrawingZones(true)
    expect(p.deleting).toBe(false)
    p.setDeleting(true)
    expect(p.zoneEditor.editing).toBe(false)
    p.setStructuring(true)
    expect(p.structuring).toBe(false)
  })
})

describe('zone names', () => {
  it('lose the full stop the transcription adds', () => {
    const z = new ZoneEditor()
    z.zones.push({ id: 'z', name: 'New zone', x0: 0, y0: 0, x1: 0.5, y1: 0.5 })
    z.rename(z.zones[0], 'Practical things.')
    expect(z.zones[0].name).toBe('Practical things')
  })
})

describe('Shake', () => {
  const wag = (s: Shake, xs: number[], step: number) => xs.map((x, i) => s.update(x, i * step))

  it('counts four quick changes of direction after real swings', () => {
    const s = new Shake()
    const hits = wag(s, [0.5, 0.56, 0.5, 0.56, 0.5, 0.56], 120)
    expect(hits.filter(Boolean)).toHaveLength(1)
    expect(hits.at(-1)).toBe(true)
  })

  it('ignores tracking jitter, a slow wave and a steady sweep', () => {
    expect(wag(new Shake(), Array.from({ length: 40 }, (_, i) => 0.5 + (i % 2 ? SWING / 3 : 0)), 33).some(Boolean)).toBe(false)
    expect(wag(new Shake(), [0.5, 0.56, 0.5, 0.56, 0.5, 0.56, 0.5, 0.56], 600).some(Boolean)).toBe(false)
    expect(wag(new Shake(), Array.from({ length: 30 }, (_, i) => 0.1 + i * 0.03), 33).some(Boolean)).toBe(false)
  })
})
