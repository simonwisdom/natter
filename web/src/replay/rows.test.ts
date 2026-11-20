import { describe, expect, it } from 'vitest'
import { clock, rowAt, spanAt, spans, toRow, toRows, type LogEvent } from './rows'

const ev = (t: number, type: string, more: Record<string, unknown> = {}): LogEvent => ({ t, type, ...more })

describe('replay rows', () => {
  it('puts what was heard, what the LLM wrote and what was done in plain words', () => {
    expect(toRow(ev(1, 'final', { text: 'cat' }))).toMatchObject({ text: '🎙️ Heard “cat”', kind: 'heard', moment: true })
    expect(toRow(ev(2, 'idea', { text: 'Cat', emoji: '🐱', ms: 974 }))).toMatchObject({ text: '✨ LLM → 🐱 Cat · 1.0 s', kind: 'claude' })
    expect(toRow(ev(3, 'merge', { text: 'a', into: 'b' }))).toMatchObject({ kind: 'did', moment: true })
  })

  it('marks what went wrong: nothing heard, a dropped idea, and the X key', () => {
    expect(toRow(ev(1, 'final', { text: ' ' }))).toMatchObject({ text: '🎙️ Heard nothing', kind: 'fail' })
    expect(toRow(ev(2, 'ideaAbandoned', { why: 'hand lost' }))?.kind).toBe('fail')
    expect(toRow(ev(3, 'key', { key: 'x' }))).toMatchObject({ kind: 'fail', moment: true })
    expect(toRow(ev(4, 'key', { key: 'g' }))).toMatchObject({ kind: 'mark', moment: true })
  })

  it('keeps other events as detail with their short values, and drops frame-by-frame readings', () => {
    const row = toRow(ev(5, 'grab', { hand: 1, bubble: 'b18', text: 'Voice agent', fingers: [1, 2], x: 0.123456 }))
    expect(row).toMatchObject({ kind: 'detail', moment: false })
    expect(row?.text).toBe('grab · hand 1 · bubble b18 · text Voice agent · x 0.12')
    expect(toRow(ev(6, 'key', { key: 'd' }))?.moment).toBe(false)
    expect(toRow(ev(7, 'raw'))).toBeUndefined()
    expect(toRow(ev(8, 'stats'))).toBeUndefined()
    expect(toRow(ev(9, 'clear'))?.text).toBe('clear')
  })

  it('orders rows by time and finds the one playing at a moment', () => {
    const rows = toRows([ev(300, 'clear'), ev(100, 'clear'), ev(150, 'raw'), ev(200, 'clear')])
    expect(rows.map(r => r.t)).toEqual([100, 200, 300])
    expect(rowAt(rows, 50)).toBe(-1)
    expect(rowAt(rows, 100)).toBe(0)
    expect(rowAt(rows, 250)).toBe(1)
    expect(rowAt(rows, 9999)).toBe(2)
  })

  it('writes times as minutes and seconds', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65_400)).toBe('1:05')
    expect(clock(65_400, true)).toBe('1:05.4')
    expect(clock(-5)).toBe('0:00')
  })

  it('places each recording in the session, by its real length once known', () => {
    const segs = [{ file: 'a', t: 1000, sound: [] }, { file: 'b', t: 60_000, sound: [] }]
    const events = [ev(40_000, 'recordStop')]
    expect(spans(segs, events, 100_000)).toEqual([{ index: 0, from: 1000, to: 40_000 }, { index: 1, from: 60_000, to: 100_000 }])
    const known = new Map([[0, 30_000]])
    const all = spans(segs, events, 100_000, known)
    expect(all[0]).toEqual({ index: 0, from: 1000, to: 31_000 })
    expect(spanAt(all, 500)).toBeUndefined()
    expect(spanAt(all, 20_000)?.index).toBe(0)
    expect(spanAt(all, 45_000)).toBeUndefined()
    expect(spanAt(all, 60_000)?.index).toBe(1)
    // The screen's recordings end at their own stop line, not the camera's.
    expect(spans([segs[0]], [...events, ev(20_000, 'screenStop')], 100_000, new Map(), 'screenStop')[0].to).toBe(20_000)
  })
})
