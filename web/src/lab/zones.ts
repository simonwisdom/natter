import type { Hand } from './body'

/** Rectangles are fractions of the reachable board, so zoom and window changes keep them usable. */
export interface Zone { id: string; name: string; x0: number; y0: number; x1: number; y1: number }
type Point = { x: number; y: number }
type Drag = { hand: number; start: Point; original?: Zone; corner?: number; rect: Zone }
export const NAME_DWELL_MS = 600 // a pointing finger must rest on a title this long before it listens for a name
const MIN = 0.12
const EDGE = 0.035
const THUMB_HOLD_MS = 600 // as long as a thumbs-down on a bubble takes to bin it
/** A spoken name longer than this is talk, not a name (the first demo got "You could name it, yeah. And then everyt"). */
export const NAME_MAX_WORDS = 5

const clean = (text: string) => text.trim().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').slice(0, 40)

/** The name spoken words become, or '' when they are empty or too long to be a name. A typed name has no word limit. */
export function spokenZoneName(text: string) {
  const name = text.trim()
  return name && name.split(/\s+/).length <= NAME_MAX_WORDS ? clean(name) : ''
}

export class ZoneEditor {
  zones: Zone[] = []
  editing = false
  draft?: Zone
  naming?: { hand: number; zone: Zone }
  aim?: { hand: number; zone: Zone; since: number }
  notice = ''
  onBeforeChange?: () => void
  onName?: (zone: Zone, hand: number, start: boolean, cancelled: boolean) => void
  onEvent?: (type: string, data: Record<string, unknown>) => void
  private drag?: Drag
  private gestures = new Map<number, string>()
  /** Hands whose thumbs-down has already deleted a zone: one held thumb deletes one zone. */
  private thumbed = new Set<number>()
  private nextId = 1

  setEditing(on: boolean) {
    if (on === this.editing) return
    this.cancel()
    this.editing = on
    this.onEvent?.('drawZones', { on })
  }

  cancel() {
    if (this.naming) this.onName?.(this.naming.zone, this.naming.hand, false, true)
    this.naming = this.aim = undefined
    this.drag = this.draft = undefined
    this.gestures.clear()
    this.thumbed.clear()
    this.notice = ''
  }

  at(p: Point) {
    return this.zones.find(z => p.x >= z.x0 && p.x < z.x1 && p.y >= z.y0 && p.y < z.y1)
  }

  /** The zone whose title bar this point is on. */
  title(p: Point) {
    return this.zones.find(z => p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y0 + 0.07)
  }

  private valid(rect: Zone, ignore?: Zone) {
    return rect.x1 - rect.x0 >= MIN && rect.y1 - rect.y0 >= MIN
      && !this.zones.some(z => z !== ignore && rect.x0 < z.x1 && rect.x1 > z.x0 && rect.y0 < z.y1 && rect.y1 > z.y0)
  }

  /** Takes a zone away; the bubbles in it stay where they are. Undo brings it back. */
  remove(zone: Zone) {
    const i = this.zones.indexOf(zone)
    if (i < 0) return false
    this.onBeforeChange?.()
    if (this.naming?.zone === zone) { this.onName?.(zone, this.naming.hand, false, true); this.naming = undefined }
    if (this.aim?.zone === zone) this.aim = undefined
    this.zones.splice(i, 1)
    this.onEvent?.('deleteZone', { id: zone.id, name: zone.name })
    this.notice = `Deleted “${zone.name}” (U brings it back)`
    return true
  }

  rename(zone: Zone, name: string) {
    name = clean(name)
    if (!name || !this.zones.includes(zone) || zone.name === name) return false
    this.onBeforeChange?.()
    zone.name = name
    this.onEvent?.('renameZone', { id: zone.id, name })
    return true
  }

  /** Hands have already been mapped into reachable-area fractions. Only one edit can run at once. */
  update(hands: Hand[], t: number) {
    if (!this.editing) return
    const byId = new Map(hands.map(h => [h.id, h]))
    if (this.drag && !byId.has(this.drag.hand)) { this.drag = this.draft = undefined }
    if (this.naming) {
      const h = byId.get(this.naming.hand)
      if (!h || h.gesture !== 'point') {
        this.onName?.(this.naming.zone, this.naming.hand, false, !h)
        this.naming = undefined
      }
    }
    if (this.aim && !byId.has(this.aim.hand)) this.aim = undefined
    for (const h of hands) {
      const prev = this.gestures.get(h.id) ?? h.gesture // entering with a fist already closed never starts a draw
      this.gestures.set(h.id, h.gesture)
      const p = { x: Math.max(0, Math.min(1, h.tipX)), y: Math.max(0, Math.min(1, h.tipY)) }
      if (this.drag) {
        if (this.drag.hand !== h.id) continue
        const d = this.drag
        if (h.gesture === 'fist') {
          if (d.original && d.corner === undefined) {
            const z = d.original, dx = Math.max(-z.x0, Math.min(1 - z.x1, p.x - d.start.x)), dy = Math.max(-z.y0, Math.min(1 - z.y1, p.y - d.start.y))
            d.rect = { ...z, x0: z.x0 + dx, x1: z.x1 + dx, y0: z.y0 + dy, y1: z.y1 + dy }
          } else {
            const anchor = d.original ? { x: d.corner! % 2 ? d.original.x0 : d.original.x1, y: d.corner! < 2 ? d.original.y1 : d.original.y0 } : d.start
            d.rect = { ...d.rect, x0: Math.min(anchor.x, p.x), x1: Math.max(anchor.x, p.x), y0: Math.min(anchor.y, p.y), y1: Math.max(anchor.y, p.y) }
          }
          this.draft = d.rect
        } else {
          const original = d.original && this.zones.find(z => z.id === d.original!.id)
          if (this.valid(d.rect, original)) {
            this.onBeforeChange?.()
            if (original) Object.assign(original, d.rect)
            else this.zones.push(d.rect)
            this.onEvent?.(original ? 'adjustZone' : 'drawZone', { ...d.rect })
            this.notice = ''
          } else this.notice = 'Leave space between zones; make each at least a hand-span wide and tall'
          this.drag = this.draft = undefined
        }
        continue
      }
      if (h.gesture !== 'thumbDown') this.thumbed.delete(h.id)
      if (this.naming) continue
      if (h.gesture === 'thumbDown') {
        if (this.aim?.hand === h.id) this.aim = undefined
        const zone = this.at(p)
        if (zone && !this.thumbed.has(h.id) && t - h.gestureSince >= THUMB_HOLD_MS) {
          this.thumbed.add(h.id)
          this.remove(zone)
        }
        continue
      }
      if (h.gesture === 'fist' && prev !== 'fist') {
        this.aim = undefined
        let hit: Zone | undefined, corner: number | undefined
        for (const z of this.zones) {
          const corners = [[z.x0, z.y0], [z.x1, z.y0], [z.x0, z.y1], [z.x1, z.y1]]
          const c = corners.findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) < EDGE * 1.5)
          if (c >= 0) { hit = z; corner = c; break }
          if (p.x >= z.x0 - EDGE && p.x <= z.x1 + EDGE && p.y >= z.y0 - EDGE && p.y <= z.y1 + EDGE
            && (Math.abs(p.x - z.x0) < EDGE || Math.abs(p.x - z.x1) < EDGE || Math.abs(p.y - z.y0) < EDGE || Math.abs(p.y - z.y1) < EDGE)) hit = z
        }
        if (!hit && this.at(p)) { this.notice = 'Start a new zone outside the existing zones'; continue }
        const rect = hit ? { ...hit } : { id: `zone-${this.nextId++}`, name: 'New zone', x0: p.x, x1: p.x, y0: p.y, y1: p.y }
        this.drag = { hand: h.id, start: p, original: hit ? { ...hit } : undefined, corner, rect }
        this.draft = rect
        this.notice = ''
      } else if (h.gesture === 'point') {
        const zone = this.title(p)
        if (!zone) { if (this.aim?.hand === h.id) this.aim = undefined; continue }
        if (this.aim?.zone !== zone || this.aim.hand !== h.id) this.aim = { hand: h.id, zone, since: t }
        else if (t - this.aim.since >= NAME_DWELL_MS) {
          this.naming = { hand: h.id, zone }
          this.aim = undefined
          this.onName?.(zone, h.id, true, false)
        }
      } else if (this.aim?.hand === h.id) this.aim = undefined
    }
    for (const id of this.gestures.keys()) if (!byId.has(id)) this.gestures.delete(id)
    for (const id of this.thumbed) if (!byId.has(id)) this.thumbed.delete(id)
  }
}
