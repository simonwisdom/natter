import { describe, expect, it } from 'vitest'
import type { Gesture, Hand } from './body'
import { Play, R } from './play'

function hand(id: number, x: number, y: number, gesture: Gesture): Hand {
  return { id, x, y, tipX: x, tipY: y, vx: 0, vy: 0, gesture, gestureSince: 0, score: 1, landmarks: [], raw: gesture, label: '', fingers: [] }
}
/** Let the board settle for `ms` with no hands on it. */
function settle(p: Play, from: number, ms = 4000) {
  for (let t = from; t <= from + ms; t += 16) p.update({ t, hands: [] })
  return from + ms
}
const gap = (p: Play, a: { x: number; y: number; scale: number }, b: { x: number; y: number; scale: number }) =>
  Math.hypot((a.x - b.x) * p.aspect, a.y - b.y) - R * a.scale - R * b.scale

/** A test board: a hub joined to three ideas, with branches of its own and two hanging off knots, all in a heap. */
function heap() {
  const p = new Play()
  const [hub, a, b, c, d, e, f, g] = p.bubbles
  p.links.push([hub.id, a.id], [hub.id, b.id], [hub.id, c.id])
  d.parent = e.parent = hub.id
  f.knot = [hub.id, c.id]
  g.knot = [hub.id, b.id]
  p.bubbles.forEach((k, i) => { k.x = 0.45 + 0.02 * (i % 3); k.y = 0.45 + 0.02 * Math.floor(i / 3) })
  return { p, hub, a, b, c, d, e, f, g }
}

describe('tidy', () => {
  it('spreads a heap out so no two bubbles touch and everything stays on the board', () => {
    const { p } = heap()
    expect(p.tidy()).toBe(true)
    settle(p, 0)
    const { x0, x1, y0, y1 } = p.bounds
    for (const k of p.bubbles) {
      expect(k.x).toBeGreaterThanOrEqual(x0); expect(k.x).toBeLessThanOrEqual(x1)
      expect(k.y).toBeGreaterThanOrEqual(y0); expect(k.y).toBeLessThanOrEqual(y1)
      for (const o of p.bubbles) if (o !== k) expect(gap(p, k, o)).toBeGreaterThan(0)
    }
  })
  it('puts what is joined to the hub in a ring round it, with clear line between', () => {
    const { p, hub, a, b, c, d, e } = heap()
    p.tidy()
    settle(p, 0)
    for (const k of [a, b, c]) {
      expect(gap(p, hub, k)).toBeGreaterThan(R * 0.8) // room for the line and its knot
      expect(gap(p, hub, k)).toBeLessThan(R * 4)
    }
    // Round the hub, not all on one side of it.
    const angles = [a, b, c, d, e].map(k => Math.atan2(k.y - hub.y, (k.x - hub.x) * p.aspect)).sort((m, n) => m - n)
    const turns = angles.map((at, i) => i ? at - angles[i - 1] : at + 2 * Math.PI - angles[angles.length - 1])
    expect(Math.max(...turns)).toBeLessThan(Math.PI * 1.2)
  })
  it('puts what hangs off a knot beyond the knot’s outer end, not between the hub’s own ring', () => {
    const { p, hub, c, f } = heap()
    p.tidy()
    settle(p, 0)
    const far = (k: { x: number; y: number }) => Math.hypot((k.x - hub.x) * p.aspect, k.y - hub.y)
    expect(far(f)).toBeGreaterThan(far(c))
  })
  it('lines up bubbles joined to nothing along the bottom, below the groups', () => {
    const p = new Play()
    const [hub, a, b, ...rest] = p.bubbles
    p.links.push([hub.id, a.id], [hub.id, b.id])
    p.tidy()
    settle(p, 0)
    const lowest = Math.max(hub.y, a.y, b.y)
    for (const k of rest) expect(k.y).toBeGreaterThan(lowest - R)
    expect(Math.max(...rest.map(k => k.y)) - Math.min(...rest.map(k => k.y))).toBeLessThan(0.03) // one row
  })
  it('changes no words, links or families, and undo puts every bubble back', () => {
    const { p } = heap()
    const before = p.bubbles.map(k => ({ id: k.id, text: k.text, parent: k.parent, x: k.x, y: k.y }))
    const links = JSON.stringify(p.links)
    p.tidy()
    settle(p, 0)
    expect(p.bubbles.map(k => ({ id: k.id, text: k.text, parent: k.parent }))).toEqual(before.map(({ id, text, parent }) => ({ id, text, parent })))
    expect(JSON.stringify(p.links)).toBe(links)
    expect(p.undo()).toBe(true)
    for (const was of before) expect(p.byId(was.id)).toMatchObject({ x: was.x, y: was.y })
  })
  it('does nothing in the overview or on an empty board', () => {
    const p = new Play()
    p.setOverview(true)
    expect(p.tidy()).toBe(false)
    const q = new Play()
    q.empty()
    expect(q.tidy()).toBe(false)
  })
  it('switches off the axes and zones it would otherwise scatter', () => {
    const p = new Play()
    p.modes.zones = true
    p.tidy()
    expect(p.modes).toMatchObject({ zones: false, axes: false })
  })
})

describe('organising a board with connections', () => {
  it('keeps connected bubbles where they were put, in different zones, instead of the lines pulling them back together', () => {
    const p = new Play()
    const [hub, a, b] = p.bubbles
    p.links.push([hub.id, a.id], [hub.id, b.id])
    const kid = p.bubbles[3]
    kid.parent = hub.id
    p.applyStructure({ kind: 'zones', zones: ['Now', 'Later', 'Never'], place: [{ id: hub.id, zone: 0 }, { id: a.id, zone: 1 }, { id: b.id, zone: 2 }, { id: kid.id, zone: 2 }] })
    settle(p, 0)
    expect(hub.x).toBeLessThan(1 / 3)
    expect(a.x).toBeGreaterThan(1 / 3); expect(a.x).toBeLessThan(2 / 3)
    expect(b.x).toBeGreaterThan(2 / 3)
    expect(kid.x).toBeGreaterThan(2 / 3) // a branch sent to another zone stays there too
  })
  it('draws them back within reach once the hub is picked up', () => {
    const p = new Play()
    const [hub, a, b] = p.bubbles
    p.links.push([hub.id, a.id], [hub.id, b.id])
    p.applyStructure({ kind: 'zones', zones: ['Now', 'Later', 'Never'], place: [{ id: hub.id, zone: 0 }, { id: a.id, zone: 1 }, { id: b.id, zone: 2 }] })
    let t = settle(p, 0)
    const apart = gap(p, hub, b)
    for (const end = t + 3000; t < end; t += 16) p.update({ t, hands: [hand(1, hub.x, hub.y, 'fist')] })
    expect(gap(p, hub, b)).toBeLessThan(apart * 0.7)
  })
})

describe('spacing', () => {
  it('leaves air between bubbles that were lying on top of each other', () => {
    const p = new Play()
    const [a, b] = p.bubbles
    b.x = a.x + 0.01; b.y = a.y
    settle(p, 0, 3000)
    expect(gap(p, a, b)).toBeGreaterThan(0.005)
  })
})
