/**
 * The replay viewer's reading of a session log: each event as a row with the time it happened,
 * a line in plain words, and a kind that decides its colour on the timeline. Pure, so it can be tested.
 */
import { feedLine } from '../lab/feed'

export interface LogEvent { t: number; type: string; [field: string]: unknown }
export type Kind = 'heard' | 'claude' | 'did' | 'fail' | 'mark' | 'detail'
export interface Row { t: number; text: string; kind: Kind; event: LogEvent; moment: boolean }
export interface Segment { file: string; t: number; sound: { file: string; mic?: number; after_s: number }[] }

/** Frame-by-frame readings: thousands a session, and never shown as rows. */
const NOISE = new Set(['raw', 'stats'])

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function kindOf(e: LogEvent, line: string): Kind {
  if (e.type === 'final') return str(e.text).trim() ? 'heard' : 'fail'
  if (e.type === 'ideaAbandoned' || e.type === 'gaveUp') return 'fail'
  if (line.startsWith('✨')) return 'claude'
  return 'did'
}

/** Short values of an event, for the rows that have no plain-words line. */
function fields(e: LogEvent): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(e)) {
    if (k === 't' || k === 'type' || v === '' || v === undefined || v === null) continue
    if (typeof v === 'object') continue
    parts.push(`${k} ${typeof v === 'number' ? +v.toFixed(2) : String(v)}`)
    if (parts.length === 5) break
  }
  return parts.join(' · ')
}

export function toRow(e: LogEvent): Row | undefined {
  if (NOISE.has(e.type)) return undefined
  if (e.type === 'key' && (e.key === 'x' || e.key === 'g')) {
    return { t: e.t, text: e.key === 'x' ? '❌ Marked: that didn’t work' : '✅ Marked: that worked', kind: e.key === 'x' ? 'fail' : 'mark', event: e, moment: true }
  }
  const line = feedLine(e.type, e)
  if (line) return { t: e.t, text: line, kind: kindOf(e, line), event: e, moment: true }
  const rest = fields(e)
  return { t: e.t, text: rest ? `${e.type} · ${rest}` : e.type, kind: 'detail', event: e, moment: false }
}

export function toRows(events: LogEvent[]): Row[] {
  const rows: Row[] = []
  for (const e of events) {
    const row = toRow(e)
    if (row) rows.push(row)
  }
  return rows.sort((a, b) => a.t - b.t)
}

/** The last row at or before a time, or -1 before the first. */
export function rowAt(rows: Row[], t: number): number {
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].t <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** A time into the session as m:ss, or m:ss.t with tenths. */
export function clock(ms: number, tenths = false): string {
  const s = Math.max(0, ms) / 1000
  const whole = Math.floor(s)
  const text = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
  return tenths ? `${text}.${Math.floor((s - whole) * 10)}` : text
}

export interface Span { index: number; from: number; to: number }

/**
 * Where each recording sits in the session. A recording's real length is only known once it has
 * loaded, so until then it is taken to run to the next recording, a logged stop, or the session's end.
 */
export function spans(segments: Segment[], events: LogEvent[], end: number, known: Map<number, number> = new Map(), stop = 'recordStop'): Span[] {
  const stops = events.filter(e => e.type === stop).map(e => e.t)
  return segments.map((s, index) => {
    const length = known.get(index)
    if (length !== undefined) return { index, from: s.t, to: s.t + length }
    const next = segments[index + 1]?.t ?? end
    const stop = stops.find(t => t > s.t && t <= next)
    return { index, from: s.t, to: stop ?? next }
  })
}

export function spanAt(all: Span[], t: number): Span | undefined {
  return all.find(s => t >= s.from && t < s.to)
}
