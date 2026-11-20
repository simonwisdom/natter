import { describe, expect, it } from 'vitest'
import type { Gesture, Hand } from './body'
import { Play, type PlayRequest } from './play'

function hand(id: number, x: number, y: number, gesture: Gesture): Hand {
  return { id, x, y, tipX: x, tipY: y, vx: 0, vy: 0, gesture, gestureSince: 0, score: 1, landmarks: [], raw: gesture, label: '', fingers: [] }
}
const frame = (p: Play, t: number, ...hands: Hand[]) => p.update({ t, hands })

/** A victory sign held on `b` and lowered: the suggest request it sends. */
function askOn(p: Play, b: { x: number; y: number }) {
  const reqs: PlayRequest[] = []
  p.onRequest = r => reqs.push(r)
  frame(p, 0, hand(1, b.x, b.y, 'victory'))
  frame(p, 450, hand(1, b.x, b.y, 'victory'))
  const during = p.asks.get(1)
  frame(p, 600, hand(1, b.x, b.y, 'palm'))
  frame(p, 900, hand(1, b.x, b.y, 'palm'))
  return { during, ask: reqs.find(r => r.kind === 'suggest') }
}

describe('a hub: one bubble with several connections', () => {
  it('is a bubble with two or more connections, and names what is connected to it', () => {
    const p = new Play()
    const [hub, a, b] = p.bubbles
    expect(p.hub(hub)).toEqual([])
    p.links.push([hub.id, a.id])
    expect(p.hub(hub)).toEqual([]) // one connection is a pair: its knot asks about that
    p.links.push([b.id, hub.id])
    expect(p.hub(hub).map(k => k.id)).toEqual([a.id, b.id])
    expect(p.hub(a)).toEqual([])
  })
  it('asks about the hub and everything connected to it together', () => {
    const p = new Play()
    const [hub, a, b, c] = p.bubbles
    const n = p.bubbles.length
    p.links.push([hub.id, a.id], [hub.id, b.id], [c.id, hub.id])
    const { during, ask } = askOn(p, hub)
    expect(during).toMatchObject({ bubble: hub.id, linkedIds: [a.id, b.id, c.id] })
    expect(ask).toMatchObject({ kind: 'suggest', idea: hub.text, linked: [a.text, b.text, c.text] })
    if (ask?.kind !== 'suggest') throw new Error('no ask')
    expect(ask).not.toHaveProperty('other')
    // The connected ideas are sent as linked, not again as the rest of the board.
    expect(ask.board).toHaveLength(n - 4)
    for (const k of [a, b, c]) expect(ask.board).not.toContain(k.text)
    // The new ideas branch from the hub.
    expect(p.bubbles.filter(k => k.parent === hub.id)).toHaveLength(2)
  })
  it('sends no linked ideas for a bubble with one connection or none', () => {
    const p = new Play()
    const [hub, a] = p.bubbles
    p.links.push([hub.id, a.id])
    const { during, ask } = askOn(p, hub)
    expect(during).toMatchObject({ linkedIds: [], linked: [] })
    expect(ask).not.toHaveProperty('linked')
    expect(ask).toMatchObject({ kind: 'suggest', idea: hub.text })
  })
  it('leaves out a connected bubble that is on its way off the board', () => {
    const p = new Play()
    const [hub, a, b, c] = p.bubbles
    p.links.push([hub.id, a.id], [hub.id, b.id], [hub.id, c.id])
    c.leaving = 'bin'
    expect(p.hub(hub).map(k => k.id)).toEqual([a.id, b.id])
  })
  it('takes connected ideas from another zone too', () => {
    const p = new Play()
    const [hub, a, b] = p.bubbles
    p.modes.zones = true
    hub.x = 0.1; a.x = 0.5; b.x = 0.9 // one in each of Keep, Try, Drop
    p.links.push([hub.id, a.id], [hub.id, b.id])
    const { ask } = askOn(p, hub)
    expect(ask).toMatchObject({ kind: 'suggest', linked: [a.text, b.text] })
  })
})
