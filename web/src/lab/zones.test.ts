import { describe, expect, it } from 'vitest'
import { ZoneEditor, spokenZoneName, type Zone } from './zones'
import type { Gesture, Hand } from './body'
import { Play, type PlayRequest } from './play'

const hand = (x: number, y: number, gesture: Gesture, id = 1): Hand => ({ id, x, y, tipX: x, tipY: y, gesture, gestureSince: 0, vx: 0, vy: 0, score: 1, landmarks: [], raw: gesture, label: '', fingers: [] })
const zone = (): Zone => ({ id: 'a', name: 'Weekend', x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.6 })
function draw(e: ZoneEditor, from: [number, number], to: [number, number]) {
  e.update([hand(...from, 'palm')], 0)
  e.update([hand(...from, 'fist')], 33)
  e.update([hand(...to, 'fist')], 66)
  e.update([hand(...to, 'palm')], 99)
}

describe('zone editing', () => {
  it('draws in either direction, shows a draft, and commits only on release', () => {
    const e = new ZoneEditor()
    e.setEditing(true)
    e.update([hand(0.8, 0.8, 'palm')], 0)
    e.update([hand(0.8, 0.8, 'fist')], 33)
    e.update([hand(0.2, 0.2, 'fist')], 66)
    expect(e.zones).toEqual([])
    expect(e.draft).toMatchObject({ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 })
    e.update([hand(0.2, 0.2, 'palm')], 99)
    expect(e.zones).toHaveLength(1)
    expect(e.draft).toBeUndefined()
  })

  it('rejects tiny and overlapping zones without replacing the last good zones', () => {
    const e = new ZoneEditor()
    e.setEditing(true)
    e.zones = [zone()]
    draw(e, [0.7, 0.7], [0.71, 0.71])
    draw(e, [0.8, 0.8], [0.3, 0.3])
    expect(e.zones).toEqual([zone()])
    expect(e.notice).not.toBe('')
    draw(e, [0.65, 0.2], [0.95, 0.6])
    expect(e.zones).toHaveLength(2)
  })

  it('moves borders, resizes corners, and rejects a move onto another zone', () => {
    const e = new ZoneEditor()
    e.setEditing(true)
    e.zones = [zone()]
    draw(e, [0.35, 0.6], [0.45, 0.7])
    expect(e.zones[0].x0).toBeCloseTo(0.3)
    expect(e.zones[0].y0).toBeCloseTo(0.3)
    draw(e, [0.6, 0.7], [0.7, 0.8])
    expect(e.zones[0]).toMatchObject({ x1: 0.7, y1: 0.8 })
    e.zones.push({ id: 'b', name: 'Other', x0: 0.75, y0: 0.3, x1: 1, y1: 0.8 })
    const before = structuredClone(e.zones)
    draw(e, [0.7, 0.5], [0.9, 0.5])
    expect(e.zones).toEqual(before)
  })

  it('cancels drafts on hand loss or exit, and requires a fresh fist after entering', () => {
    const e = new ZoneEditor()
    e.setEditing(true)
    e.update([hand(0.2, 0.2, 'fist')], 0)
    expect(e.draft).toBeUndefined()
    e.update([hand(0.2, 0.2, 'palm')], 33)
    e.update([hand(0.2, 0.2, 'fist')], 66)
    e.update([hand(0.8, 0.8, 'fist')], 99)
    e.update([], 132)
    expect(e.zones).toEqual([])
    expect(e.draft).toBeUndefined()
    e.update([hand(0.2, 0.2, 'palm')], 200)
    e.update([hand(0.2, 0.2, 'fist')], 233)
    e.setEditing(false)
    expect(e.draft).toBeUndefined()
  })

  it('listens once while pointing at a title, finishes on opening, and cancels on loss', () => {
    const e = new ZoneEditor(), events: unknown[] = []
    e.setEditing(true)
    e.zones = [zone()]
    e.onName = (_z, _h, start, cancelled) => events.push([start, cancelled])
    e.update([hand(0.35, 0.23, 'point')], 0)
    e.update([hand(0.35, 0.23, 'point')], 600)
    e.update([hand(0.35, 0.23, 'point')], 900)
    e.update([hand(0.35, 0.23, 'palm')], 950)
    expect(events).toEqual([[true, false], [false, false]])
    e.update([hand(0.35, 0.23, 'point')], 1000)
    e.update([hand(0.35, 0.23, 'point')], 1600)
    e.update([], 1700)
    expect(events.at(-1)).toEqual([false, true])
    expect(e.rename(e.zones[0], '   ')).toBe(false)
    expect(e.zones[0].name).toBe('Weekend')
  })

  it('freezes bubbles during edits, undoes zone changes and ignores a late name after undo', () => {
    const p = new Play()
    p.bounds = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }
    p.bubbles[0].vx = 3
    const before = structuredClone(p.bubbles)
    p.setDrawingZones(true)
    const step = (t: number, x: number, y: number, g: Gesture) => p.update({ t, hands: [hand(x, y, g)] })
    step(0, 0.2, 0.2, 'palm'); step(33, 0.2, 0.2, 'fist')
    step(66, 0.5, 0.7, 'fist'); step(99, 0.5, 0.7, 'palm')
    expect(p.bubbles).toEqual(before)
    const z = p.zoneRects[0]
    expect(z.x0).toBeCloseTo(0.125)
    p.zoneEditor.rename(z, 'Local ideas')
    p.undo()
    expect(p.zoneRects[0].name).toBe('New zone')
    expect(p.zoneEditor.rename(z, 'Late name')).toBe(false)
    p.undo()
    expect(p.zoneRects).toEqual([])
    p.setDrawingZones(false)
    expect(p.zoneEditor.editing).toBe(false)
  })

  it('deletes a zone with a thumbs-down held inside it, once per thumb, and undo brings it back', () => {
    const p = new Play()
    p.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 }
    p.setDrawingZones(true)
    draw(p.zoneEditor, [0.05, 0.1], [0.45, 0.9])
    draw(p.zoneEditor, [0.55, 0.1], [0.95, 0.9])
    p.zoneEditor.rename(p.zoneRects[0], 'Keep')
    const bubbles = structuredClone(p.bubbles)
    const thumb = (t: number, x: number, since: number) => p.update({ t, hands: [{ ...hand(x, 0.5, 'thumbDown'), gestureSince: since }] })
    thumb(1000, 0.2, 1000)
    thumb(1500, 0.2, 1000) // not held long enough yet
    expect(p.zoneRects).toHaveLength(2)
    thumb(1650, 0.2, 1000)
    expect(p.zoneRects.map(z => z.name)).toEqual(['New zone'])
    expect(p.zoneEditor.notice).toContain('Deleted “Keep”')
    thumb(1700, 0.7, 1000) // the same thumb moved onto the other zone deletes nothing more
    expect(p.zoneRects).toHaveLength(1)
    thumb(3000, 0.5, 1000) // between zones: nothing to delete
    expect(p.bubbles).toEqual(bubbles)
    p.undo()
    expect(p.zoneRects.map(z => z.name)).toEqual(['Keep', 'New zone'])
  })

  it('a thumbs-down while not drawing zones leaves zones alone', () => {
    const p = new Play()
    p.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 }
    p.bubbles = []
    p.setDrawingZones(true)
    draw(p.zoneEditor, [0.05, 0.1], [0.45, 0.9])
    p.setDrawingZones(false)
    p.update({ t: 1000, hands: [{ ...hand(0.2, 0.5, 'thumbDown'), gestureSince: 0 }] })
    expect(p.zoneRects).toHaveLength(1)
  })

  it('a spoken name over five words is talk, not a name; a typed one is kept', () => {
    expect(spokenZoneName('Weekend ideas.')).toBe('Weekend ideas')
    expect(spokenZoneName('  ')).toBe('')
    expect(spokenZoneName('You could name it, yeah. And then everything')).toBe('')
    const e = new ZoneEditor()
    e.zones = [zone()]
    expect(e.rename(e.zones[0], 'Things we could try next week')).toBe(true)
  })

  it('uses drawn rectangles for idea context and gives unzoned bubbles no other board context', () => {
    const p = new Play()
    p.setDrawingZones(true)
    draw(p.zoneEditor, [0.05, 0.1], [0.48, 0.9])
    p.zoneEditor.rename(p.zoneRects[0], 'Nearby')
    p.setDrawingZones(false)
    const [b, local, outside] = p.bubbles
    p.bubbles = [b, local, outside]
    b.x = 0.25; b.y = 0.3; local.x = 0.2; local.y = 0.75; outside.x = 0.8; outside.y = 0.75
    const reqs: PlayRequest[] = []
    p.onRequest = r => reqs.push(r)
    p.update({ t: 0, hands: [hand(b.x, b.y, 'victory')] })
    p.update({ t: 450, hands: [hand(b.x, b.y, 'victory')] })
    p.update({ t: 500, hands: [] }) // the ask is sent when the sign goes
    expect(reqs.at(-1)).toMatchObject({ kind: 'suggest', zone: 'Nearby', board: [local.text] })
    p.update({ t: 1000, hands: [hand(outside.x, outside.y, 'victory')] })
    p.update({ t: 1450, hands: [hand(outside.x, outside.y, 'victory')] })
    p.update({ t: 1500, hands: [] })
    expect(reqs.at(-1)).toMatchObject({ kind: 'suggest', zone: 'Outside zones', board: [], branches: [] })
  })
})
