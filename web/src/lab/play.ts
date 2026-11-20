/**
 * Body Lab interactions: what hands do to idea bubbles.
 * Positions are board fractions (x across the width, y down the height); sizes and distances
 * are in board heights, so bubbles stay round on any screen (`aspect` converts).
 *
 * Fist on a bubble      pick it up; open the hand to drop it; let go while moving fast to fling it away
 * Drop onto another     the two merge into one idea
 * Second fist anywhere  stretch or squeeze the held bubble (size = how much it matters)
 * Fist on empty space   hold it closed a moment for a new idea (say it); open the hand to place it.
 *                       Set it down gently and it lands small; throw it down and it lands big.
 * Point at a bubble     rest a fingertip on it for a moment, then pull a branch out (say it);
 *                       open the hand to plant it, or open it back over the bubble to cancel
 * Point, land on another bubble   open the hand there to connect the two (again to disconnect)
 * Victory sign on a bubble        ask Claude for two more ideas branching from it. Say an angle while
 *                                 holding the sign ("risks", "cheaper") and both ideas answer it; lower the sign to send
 * Victory sign on a knot          every connection has a knot at its middle. The same sign there asks for two ideas
 *                                 from the pair ("similarities", "differences"); they hang off the knot, and the angle stays on the line
 * Thumbs up / down      star / bin
 * Delete mode           (from the side rail) a pointing finger that rests on a bubble burns it up; nothing else does anything.
 *                       Shake the finger from side to side to put the fire out.
 * Both hands raised, open         say how to organise the board (axes or zones); lower them when done
 * Stretch a bubble large          it opens to show everything that was said
 *
 * Two fists on empty space        push them together to zoom out to the overview: the canvas is a grid of screen-sized
 *                                 areas, each shown small with a name from Claude. There, rest a pointing finger on an
 *                                 area (or pull two fists apart over it) to go in. An empty area is fresh space.
 *
 * Overlays: axes and zones are drawn over the same bubbles. With zones on, a flung bubble
 * stays on the board and slides to where it was thrown.
 * Workbench: a two-handed stretch, squeeze or crossing of the hands doesn't resize the bubble;
 * it grows a reworked version of the idea (further, simpler, opposite) as a branch.
 *
 * Play never talks to the server. It asks for words through `onRequest` and gets them back
 * through `setText`; with nobody listening it fills in placeholder text itself.
 */
import type { Hand } from './body'
import { Shake } from './shake'
import { ZoneEditor, type Zone } from './zones'

/** Radius of a bubble at scale 1, in board heights. */
export const DEFAULT_R = 0.085
export let R = DEFAULT_R
export function setBubbleSize(r: number) {
  R = Math.min(0.14, Math.max(0.05, r))
}
const FLING_SPEED = 1.3 // board units per second at release
const THUMB_HOLD_MS = 600
const GRAB_REACH = 0.035 // a fist this close to a bubble's rim still grabs it (board heights)
export const IDEA_ARRIVED_MS = 1200 // ...and this long if the hand came into view already closed and has not been seen open
export const IDEA_DWELL_MS = 350// a fist must stay closed on empty space this long to start a new idea
export const IDEA_MAX_MS = 10_000 // an idea held longer than this is talk, not an idea: it is let go, so a closed hand doesn't hold the microphone
export const IDEA_KEEP_MS = 800 // an idea held this long is put down where it was if the camera loses the hand (people lower their arm to finish)
const STRETCH_PER_HEIGHT = 2.6 // moving the hands a whole board height apart adds this much to the scale
const JOIN_MS = 400 // two fists closed this close together in time count as one two-handed grab
const MERGE_OVERLAP = 0.6 // centres closer than this fraction of the two radii: dropping merges them
const LINK_GAP = 0.04
const BRANCH_GAP = 0.09 // a new branch starts with this much clear line to what it grew from, so chains don't pack tight
const PAD = 0.015 // bubbles lying on the board keep this much air between their rims
export const BURN_MS = 450 // in delete mode, a fingertip must rest on a bubble this long to bin it
export const BURN_OUT_MS = 900 // how long a deleted bubble takes to burn away
const BURN_STILL = 0.6 // board widths a second: a hand moving faster than this isn't resting on anything
export const DELETE_IDLE_MS = 20_000 // delete mode switches itself off when nothing has been binned for this long
export const POINT_DWELL_MS = 400// a fingertip must rest on a bubble this long to start a branch
export const HUB_MIN = 2 // a bubble with this many connections is a hub: an ask on it is about all of them together
export const ASK_DWELL_MS = 400 // a victory sign must rest on a bubble this long to ask Claude
const ASK_GRACE_MS = 250 // the sign may drop out this long without ending the ask (a misread frame mustn't cut the speaker off)
export const ASK_MAX_MS = 8000 // an ask sends itself after this long, so a sign left up doesn't hold the microphone
export const KNOT_DRAWN = 0.3 // a connection's knot as drawn, as a share of R
const KNOT_HIT = 0.6 // ...and the larger circle a fingertip has to land in
const KNOT_ROOM = 1.3 // connected bubbles keep this many R of clear line between their rims, so the knot can be reached
const KNOT_CLEAR = 1.3 // what hangs off a knot starts with its rim this many R away, clear of the knot and the angle written under it
export const OPEN_AT = 1.6 // a bubble stretched this large opens to show everything that was said
export const RAISE_Y = 0.32 // both open hands above this line (top third) means "organise the board"
export const RAISE_MS = 700
const LOWER_MS = 350
const SUGGESTIONS = 2
export const DIVE_MS = 700 // in the overview, a pointing finger must rest on an area this long to go there
const CANVAS_PULL = 0.12 // two fists must close or open by this much (board heights) to zoom out or in
const CANVAS_JOIN_MS = 750 // two fists that close on empty space within this of each other hold the canvas; a later second fist is ignored, as before
/** A colour per family: every root idea takes the next, and its branches inherit it. */
export const PALETTE = ['blue', 'orange', 'purple', 'green', 'pink', 'teal']

export type Rework = 'further' | 'smaller' | 'opposite' | 'combine'

export type PlayRequest =
  /** A hand started holding an idea: start listening. */
  | { kind: 'listenStart'; hand: number }
  /** The idea was placed as `bubbleId` (its text is whatever was said), or abandoned. */
  | { kind: 'listenEnd'; hand: number; bubbleId?: string }
  /** `bubbleId` needs text: `idea` reworked, or `idea` and `other` combined. */
  | { kind: 'rework'; bubbleId: string; how: Rework; idea: string; other?: string; zone?: string; board?: string[] }
  /** A victory sign settled on a bubble or a knot: listen for an angle until the `suggest` from the same hand. */
  | { kind: 'askStart'; hand: number }
  /**
   * `bubbleIds` are new branches of `idea` that need Claude's own suggestions. With `other`, they hang off the
   * knot between the two and come from the pair. `hand` is whose sign it was, if it could be saying an angle.
   */
  | { kind: 'suggest'; bubbleIds: string[]; idea: string; other?: string; /** A hub's connected ideas: the new ones come from all of them together. */ linked?: string[]; hand?: number; branches: string[]; board: string[]; zone?: string }
  /** Both hands went up (start listening for how to organise the board) or came down. */
  | { kind: 'structureStart' }
  | { kind: 'structureEnd' }
  | { kind: 'zoneName'; zone: Zone; hand: number; start: boolean; cancelled: boolean }
  /** The area `key` is being shown in the overview and its ideas have changed: it needs a name. */
  | { kind: 'area'; key: string; labels: string[] }

/** How Claude says the board should be organised (see applyStructure). */
export type Structure =
  | { kind: 'axes'; x: [string, string]; y: [string, string]; place: { id: string; x: number; y: number }[] }
  | { kind: 'zones'; zones: string[]; place: { id: string; zone: number }[] }
  | { kind: 'clear' }
  | { kind: 'none' }

export interface Bubble {
  id: string
  text: string
  emoji: string
  colour: string
  x: number
  y: number
  scale: number
  starred: boolean
  vx: number
  vy: number
  holders: number[]
  /** The idea this one grew out of. */
  parent?: string
  /** Or the two connected ideas it grew out of: it hangs off the knot between them. */
  knot?: [string, string]
  /** Waiting for its words. */
  pending: boolean
  /** Everything behind the short label: what was actually said, or where a reworked idea came from. */
  full?: string
  /** Stretched open on purpose (two fists or the wheel) to show `full`. Growing from merges never opens it. */
  opened?: boolean
  /** Claude's own idea, not something a person said. */
  byClaude?: boolean
  /** Where it is gliding to after the board was organised. */
  goal?: { x: number; y: number }
  /** Organising put it where it belongs, perhaps far from what it is joined to: its lines stretch instead of pulling it back, until one end is picked up. */
  loose?: boolean
  /** While held over another bubble: the one it would merge into if dropped. */
  mergeInto?: string
  /** Workbench, while held in two hands: what letting go would do. */
  hint?: Rework
  /** Binned or flung: on its way off the board. */
  leaving?: 'bin' | 'fling' | 'burn'
  /** When it started leaving (a burning bubble is gone BURN_OUT_MS later). */
  leftAt?: number
  bornAt: number
}

interface HandState {
  bubble?: string
  offX: number
  offY: number
  idea: boolean
  ideaSince: number
  branchFrom?: string
  /** A fingertip resting on a bubble, not yet long enough to act. */
  aim?: Aim
  /** This hand has been seen as something other than a fist: a hand that only ever showed up closed is more often one hanging at someone's side. */
  opened?: boolean
  /** When this hand last closed into a fist. */
  fistAt?: number
  /** This victory sign has already asked; it must be dropped before asking again. */
  asked?: boolean
  x: number
  y: number
  gesture: string
  thumbDone: boolean
  /** Whose hand it is, when two people are in shot. */
  person?: number
}

/** Something a hand is counting down to. For 'idea' (a fist on empty space) there is no bubble. */
export interface Aim { bubble: string; since: number; kind: 'branch' | 'ask' | 'idea' | 'burn'; /** For an ask on a knot: the bubble at the other end. */ other?: string }

/** A victory sign being held after it asked: the new bubbles are out, and the hand may be saying an angle. */
export interface Ask {
  bubble: string
  other?: string
  since: number
  lostAt?: number
  made: string[]
  idea: string
  otherIdea?: string
  /** For an ask on a hub: the bubbles connected to it (ids), and their words when the ask began. */
  linkedIds: string[]
  linked: string[]
  branches: string[]
  board: string[]
  zone?: string
}

type Snapshot = { bubbles: Bubble[]; links: [string, string][]; words: [string, string][]; zones: Zone[]; manualZones: boolean; labels: { x: string[]; y: string[]; zones: string[] }; modes: { axes: boolean; zones: boolean; workbench: boolean } }

/** A screen-sized part of the canvas that isn't the one on screen: kept as it was left. */
interface Area { col: number; row: number; bubbles: Bubble[]; links: [string, string][]; words: [string, string][]; history: Snapshot[]; overlay: Overlay }

/** The zones or axes laid over one area: they belong to it, like its undo history. */
interface Overlay { zones: Zone[]; manualZones: boolean; labels: { x: string[]; y: string[]; zones: string[] }; axes: boolean; zonesOn: boolean }
const PLAIN = (): Overlay => ({ zones: [], manualZones: false, labels: { x: ['easy', 'hard'], y: ['small win', 'big win'], zones: ['Keep', 'Try', 'Drop'] }, axes: false, zonesOn: false })

/** One area as the overview shows it: where its tile sits on the board (fractions), and what is in it. */
export interface Cell {
  key: string
  col: number
  row: number
  x0: number
  y0: number
  x1: number
  y1: number
  /** The area that was on screen before zooming out. */
  current: boolean
  bubbles: Bubble[]
  links: [string, string][]
  name?: string
  emoji?: string
}

export interface PlayInput {
  t: number
  hands: Hand[]
  /** Both hands are above the head, from the body pose. Left out, the top of the board is used instead. */
  raised?: boolean
}

// Example ideas for trying things out (R). An everyday subject on purpose: Claude reads the
// board when it suggests and combines, and takes its tone from what is there.
const SEED: [string, string][] = [
  ['Sleep in', '😴'],
  ['Long walk', '🥾'],
  ['Cook something new', '🍳'],
  ['Call an old friend', '📞'],
  ['Read in the park', '📖'],
  ['Fix the bike', '🚲'],
  ['See a film', '🎬'],
  ['Do nothing at all', '🛋️'],
]

const SPARE: [string, string][] = [
  ['Swim in the sea', '🌊'], ['Bake bread', '🍞'], ['Write a letter', '✉️'], ['Plant something', '🌱'],
  ['Visit a museum', '🏛️'], ['Play a board game', '🎲'], ['Watch the sunset', '🌅'], ['Learn a song', '🎵'],
]

export function fallbackText(how: Rework, idea: string, other?: string): string {
  if (how === 'combine') return `${other} + ${idea}`
  return { further: 'Even more: ', smaller: 'Just: ', opposite: 'Not: ' }[how] + idea
}

export class Play {
  bubbles: Bubble[] = []
  zoneEditor = new ZoneEditor()
  private manualZones = false
  modes = { axes: false, zones: false, workbench: false }
  /** Board width divided by height. */
  aspect = 16 / 9
  /**
   * The part of the board the hands can reach (the camera's view, less its unreliable edge).
   * Bubbles are kept inside it, so nothing ever sits where it can't be picked up.
   */
  bounds = { x0: 0, y0: 0, x1: 1, y1: 1 }
  /** Hands holding an idea that hasn't been placed yet, and the bubble it branches from. */
  ideas = new Map<number, { parent?: string; x: number; y: number; over?: string }>()
  /** The hands whose idea has had words heard so far (set by whoever listens). */
  heard = new Set<number>()
  /** Fingertips resting on a bubble and counting down to a branch or a question. */
  aims = new Map<number, Aim>()
  /** Victory signs still held after asking Claude, by hand: listening for an angle until the sign is lowered. */
  asks = new Map<number, Ask>()
  /** How many microphones there are: with two, each person can be saying an idea at the same time. */
  voices = 1
  /** Connections between ideas that didn't grow from one another. */
  links: [string, string][] = []
  /** The angle last asked through on a connection, shown on its line. */
  private linkWords = new Map<string, string>()
  /** The words on the axes and zones overlays; Claude rewrites them when the board is organised by voice. */
  labels = { x: ['easy', 'hard'], y: ['small win', 'big win'], zones: ['Keep', 'Try', 'Drop'] }
  /** Both hands are up and the board is listening for how to organise itself. */
  structuring = false
  /** When both hands went up, while counting down to listening. */
  raisedAt?: number
  onRequest?: (req: PlayRequest) => void
  /** Everything that happens, for the session log. */
  onEvent?: (type: string, data: Record<string, unknown>) => void
  private hands = new Map<number, HandState>()
  private stretch = new Map<string, { dist: number; scale: number; sign: number }>()
  private lastT?: number
  private nextId = 1
  private nextSpare = 0
  private history: Snapshot[] = []
  /** Zoomed out: every area of the canvas is shown small, and hands only choose where to go. */
  overview = false
  /** Which area of the canvas is on screen. */
  area = { col: 0, row: 0 }
  /** Two fists holding the canvas: how far apart they were when they closed, and are now. */
  canvasHold?: { hands: [number, number]; dist: number; now: number }
  /** In the overview: the area a pointing finger is resting on, counting down to going there. */
  overviewAim?: { key: string; since: number; hand: number }
  private areas = new Map<string, Area>()
  /** Each area's name, and the ideas it was named for. */
  private names = new Map<string, { text: string; emoji: string; of: string }>()
  /** Hands that were a fist, pointing or making a victory sign when the view changed, and as what: each must change before it can do anything. */
  private spent = new Map<number, string>()
  private shapes = new Map<number, string>()
  private nextColour = 0
  private loweredAt?: number

  constructor() {
    this.zoneEditor.onBeforeChange = () => this.checkpoint()
    this.zoneEditor.onName = (zone, hand, start, cancelled) => this.onRequest?.({ kind: 'zoneName', zone, hand, start, cancelled })
    this.zoneEditor.onEvent = (type, data) => this.onEvent?.(type, data)
    this.reset()
  }

  get zoneRects(): Zone[] {
    if (!this.modes.zones) return []
    return this.manualZones ? this.zoneEditor.zones : this.labels.zones.map((name, i, a) => ({ id: `column-${i}`, name, x0: i / a.length, x1: (i + 1) / a.length, y0: 0.11, y1: 0.89 }))
  }

  /** Delete mode: pointing bins, and nothing else starts. */
  deleting = false
  /** Why delete mode last switched itself off, for the page to say so; the page clears it. */
  deleteEnded?: 'shake' | 'idle'
  private deleteSince = 0
  private shakes = new Map<number, Shake>()

  setDeleting(on: boolean, why?: 'shake' | 'idle') {
    if (on === this.deleting) return
    this.shakes.clear()
    this.canvasHold = undefined
    this.deleteEnded = on ? undefined : why
    if (on) {
      this.setDrawingZones(false)
      this.setStructuring(false)
      this.cancelAsks()
      for (const [id, st] of this.hands) {
        if (st.idea) this.endIdea(id, st, undefined, this.lastT ?? 0)
        if (st.bubble) { const b = this.byId(st.bubble); if (b) b.holders = [] }
      }
      this.hands.clear()
      this.deleteSince = this.lastT ?? 0
    }
    this.aims.clear()
    this.deleting = on
    this.onEvent?.('deleteMode', { on, why })
  }

  setDrawingZones(on: boolean) {
    if (on === this.zoneEditor.editing) return
    this.canvasHold = undefined
    if (on) {
      this.setDeleting(false)
      this.setStructuring(false)
      this.cancelAsks()
      for (const [id, st] of this.hands) {
        if (st.idea) this.endIdea(id, st, undefined, this.lastT ?? 0)
        if (st.bubble) { const b = this.byId(st.bubble); if (b) b.holders = [] }
      }
      this.checkpoint()
      if (!this.manualZones) this.zoneEditor.zones = this.zoneRects.map(z => ({ ...z }))
      this.manualZones = true
      this.modes.zones = true
      this.modes.axes = false
      this.hands.clear()
    }
    this.zoneEditor.setEditing(on)
  }

  reset() {
    for (const id of this.ideas.keys()) this.onRequest?.({ kind: 'listenEnd', hand: id })
    this.cancelAsks()
    this.areas.clear()
    this.names.clear()
    this.area = { col: 0, row: 0 }
    this.overview = false
    this.canvasHold = this.overviewAim = undefined
    this.spent.clear()
    this.nextColour = 0
    this.links = []
    this.linkWords.clear()
    this.bubbles = SEED.map(([text, emoji], i) => {
      const at = this.within(0.14 + (i % 4) * 0.24, 0.3 + Math.floor(i / 4) * 0.4)
      return this.bubble(text, emoji, this.rootColour(), at.x, at.y, 0)
    })
    this.hands.clear()
    this.ideas.clear()
    this.aims.clear()
    this.history = []
    this.stretch.clear()
  }

  private bubble(text: string, emoji: string, colour: string, x: number, y: number, t: number): Bubble {
    return {
      id: `b${this.nextId++}`, text, emoji, colour, x, y, scale: 1, starred: false,
      vx: 0, vy: 0, holders: [], pending: false, bornAt: t,
    }
  }

  /** A point given as fractions of the reachable area, as a board position. */
  private within(u: number, v: number) {
    const { x0, y0, x1, y1 } = this.bounds
    return { x: x0 + u * (x1 - x0), y: y0 + v * (y1 - y0) }
  }

  /** Start with nothing on the board (R brings the example ideas). */
  empty() {
    this.reset()
    this.bubbles = []
  }

  /** Remember the board as it is now, so the change about to happen can be undone. */
  private checkpoint() {
    this.history.push({
      bubbles: this.bubbles.filter(b => !b.leaving).map(b => ({ ...b, holders: [], mergeInto: undefined, hint: undefined, goal: undefined, vx: 0, vy: 0 })),
      links: this.links.map(l => [...l] as [string, string]),
      words: [...this.linkWords],
      zones: this.zoneEditor.zones.map(z => ({ ...z })), manualZones: this.manualZones,
      labels: structuredClone(this.labels), modes: { ...this.modes },
    })
    if (this.history.length > 40) this.history.shift()
  }

  /** Put the board back as it was before the last change. Returns false if there is nothing to undo. */
  undo(): boolean {
    const before = this.history.pop()
    if (!before) return false
    this.cancelAsks() // their new bubbles came after the checkpoint
    this.zoneEditor.cancel()
    this.zoneEditor.zones = before.zones
    this.manualZones = before.manualZones
    this.labels = before.labels
    this.modes = before.modes
    if (!this.manualZones) this.zoneEditor.setEditing(false)
    for (const st of this.hands.values()) st.bubble = undefined
    this.stretch.clear()
    const now = new Map(this.bubbles.map(b => [b.id, b]))
    // Words that arrived after the checkpoint are kept; a bubble still waiting for words then is dropped.
    this.links = before.links
    this.bubbles = before.bubbles.flatMap(b => {
      if (!b.pending) return [b]
      const cur = now.get(b.id)
      return cur && !cur.pending ? [{ ...b, text: cur.text, emoji: cur.emoji, pending: false }] : []
    })
    const ids = new Set(this.bubbles.map(b => b.id))
    for (const b of this.bubbles) if (b.parent && !ids.has(b.parent)) b.parent = undefined
    this.links = this.links.filter(([a, b]) => ids.has(a) && ids.has(b))
    // The angle on a line goes back too, except one that arrived since for bubbles that are still here.
    const words = new Map(before.words)
    for (const [key, word] of this.linkWords) {
      if (!words.has(key) && this.bubbles.some(b => b.knot && [...b.knot].sort().join('|') === key)) words.set(key, word)
    }
    this.linkWords = words
    this.onEvent?.('undo', { bubbles: this.bubbles.length })
    return true
  }

  /** Empty the board (undoable). */
  clear() {
    this.cancelAsks()
    this.checkpoint()
    for (const st of this.hands.values()) st.bubble = undefined
    this.stretch.clear()
    this.bubbles = []
    this.links = []
    this.onEvent?.('clear', {})
  }

  byId(id?: string): Bubble | undefined {
    return id ? this.bubbles.find(b => b.id === id) : undefined
  }

  private rootColour(): string {
    return PALETTE[this.nextColour++ % PALETTE.length]
  }

  /** Give a bubble's whole family (everything branching from it) its colour. */
  private recolour(root: Bubble) {
    for (const k of this.bubbles) if (k.parent === root.id && k !== root) { k.colour = root.colour; this.recolour(k) }
  }

  /** A bubble on screen or in an area that was left. */
  find(id?: string): Bubble | undefined {
    if (!id) return undefined
    const here = this.byId(id)
    if (here) return here
    for (const a of this.areas.values()) { const b = a.bubbles.find(k => k.id === id); if (b) return b }
    return undefined
  }

  /** Words arrived for a bubble (it may be in an area that was left while it waited). */
  setText(id: string, text: string, emoji?: string) {
    const b = this.find(id)
    if (!b) return
    b.text = text
    if (emoji) b.emoji = emoji
    b.pending = false
  }

  /** Take a bubble off the board at once (for example, nothing was heard). */
  remove(id: string) {
    const b = this.byId(id)
    if (!b) {
      for (const a of this.areas.values()) {
        if (!a.bubbles.some(k => k.id === id)) continue
        a.bubbles = a.bubbles.filter(k => k.id !== id)
        for (const k of a.bubbles) if (k.parent === id) k.parent = undefined
        a.links = a.links.filter(l => !l.includes(id))
        // An area with nothing left in it is forgotten, as when it is left empty.
        if (!a.bubbles.length) { const key = `${a.col},${a.row}`; this.areas.delete(key); this.names.delete(key) }
      }
      return
    }
    this.detach(b)
    this.bubbles = this.bubbles.filter(k => k !== b)
  }

  /** Distance between two board points, in board heights. */
  private dist(ax: number, ay: number, bx: number, by: number) {
    return Math.hypot((ax - bx) * this.aspect, ay - by)
  }

  private wheeled?: { id: string; t: number }

  /** Resize the bubble at this point by `factor`: the mouse wheel standing in for a second hand. One turn of the wheel is one step to undo. */
  resizeAt(x: number, y: number, factor: number, t: number): Bubble | undefined {
    const b = this.bubbleAt(x, y)
    if (!b || b.pending || this.zoneEditor.editing) return undefined
    if (this.wheeled?.id !== b.id || t - this.wheeled.t > 600) this.checkpoint()
    this.wheeled = { id: b.id, t }
    b.scale = Math.min(2.6, Math.max(0.5, b.scale * factor))
    b.opened = b.scale >= OPEN_AT
    return b
  }

  bubbleAt(x: number, y: number, except?: Bubble): Bubble | undefined {
    // Last in the list is drawn on top.
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i]
      if (b.leaving || b === except) continue
      if (this.dist(x, y, b.x, b.y) <= R * b.scale * 1.1) return b
    }
    return undefined
  }

  /** The settled bubble whose rim is closest to this point, and how far outside that rim the point is (0 on the bubble). */
  private nearest(x: number, y: number, except?: Bubble): { bubble: Bubble; gap: number } | undefined {
    let best: { bubble: Bubble; gap: number } | undefined
    for (const b of this.bubbles) {
      if (b.leaving || b.pending || b === except) continue
      const gap = Math.max(0, this.dist(x, y, b.x, b.y) - R * b.scale)
      if (!best || gap < best.gap) best = { bubble: b, gap }
    }
    return best
  }

  /** Where the knot on a connection sits: the middle of the line showing between the two rims. */
  knot(a: Bubble, b: Bubble) {
    const d = this.dist(a.x, a.y, b.x, b.y) || 1
    const f = 0.5 + (R * a.scale - R * b.scale) / (2 * d)
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
  }

  /** The connection whose knot is at this point, as its two bubbles. */
  knotAt(x: number, y: number): [Bubble, Bubble] | undefined {
    for (let i = this.links.length - 1; i >= 0; i--) {
      const p = this.byId(this.links[i][0]), q = this.byId(this.links[i][1])
      if (!p || !q || p.leaving || q.leaving) continue
      const k = this.knot(p, q)
      if (this.dist(x, y, k.x, k.y) <= R * KNOT_HIT) return [p, q]
    }
    return undefined
  }

  /** The angle shown on the line between two connected bubbles, if one was asked through. */
  linkWord(a: string, b: string): string | undefined {
    return this.linkWords.get([a, b].sort().join('|'))
  }

  /** The bubble a hand at this point takes hold of: the one it is on, or failing that the nearest within reach of its rim. */
  private grabbable(x: number, y: number): Bubble | undefined {
    const on = this.bubbleAt(x, y)
    if (on) return on
    let best: Bubble | undefined, bestD = GRAB_REACH
    for (const b of this.bubbles) {
      if (b.leaving) continue
      const d = this.dist(x, y, b.x, b.y) - R * b.scale
      if (d < bestD) { bestD = d; best = b }
    }
    return best
  }

  private get here() {
    return `${this.area.col},${this.area.row}`
  }

  /** The name shown on an area in the overview. */
  setAreaName(key: string, text: string, emoji = '') {
    const n = this.names.get(key)
    if (n && text.trim()) this.names.set(key, { ...n, text: text.trim(), emoji })
  }

  /**
   * Zoom out to the overview, or back in to where you were. Zooming out lets go of everything
   * in hand, and asks for a name for this area if its ideas changed since it was last named.
   */
  setOverview(on: boolean) {
    if (on === this.overview) return
    if (!on) return this.dive(this.area.col, this.area.row)
    if (this.zoneEditor.editing || this.deleting || this.structuring) return
    this.letGo()
    this.overview = true
    const labels = this.bubbles.filter(b => !b.pending && !b.leaving).map(b => b.text)
    const of = labels.join('|'), named = this.names.get(this.here)
    if (!labels.length) this.names.delete(this.here)
    else if (named?.of !== of) {
      // Until Claude answers (or if it never does): the old name, or the first idea and how many more.
      this.names.set(this.here, { text: named?.text ?? (labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0]), emoji: named?.emoji ?? '', of })
      // One idea names its own area; more than one is Claude's to sum up.
      if (labels.length > 1) this.onRequest?.({ kind: 'area', key: this.here, labels: labels.slice(0, 30) })
      else this.names.set(this.here, { text: labels[0], emoji: '', of })
    }
    this.onEvent?.('overview', { on: true, areas: this.areas.size + 1 })
  }

  /** Everything in hand is put down or taken back, and fists that are closed must open before they count again. */
  private letGo() {
    this.cancelAsks()
    for (const [id, st] of this.hands) {
      if (st.idea) this.endIdea(id, st, undefined, this.lastT ?? 0, 'view changed')
      if (st.bubble) { const b = this.byId(st.bubble); if (b) { b.holders = []; b.mergeInto = undefined; b.hint = undefined } }
    }
    this.hands.clear()
    this.aims.clear()
    this.stretch.clear()
    this.canvasHold = this.overviewAim = undefined
    for (const [id, shape] of this.shapes) if (shape === 'fist' || shape === 'point' || shape === 'victory') this.spent.set(id, shape)
  }

  /** Go to an area of the canvas: the one on screen is kept as it is, and the other takes its place. An area never visited is empty. */
  dive(col: number, row: number) {
    const key = `${col},${row}`
    this.setDrawingZones(false)
    this.letGo()
    if (key !== this.here) {
      const left = this.bubbles.filter(b => !b.leaving)
      const overlay: Overlay = { zones: this.zoneEditor.zones, manualZones: this.manualZones, labels: this.labels, axes: this.modes.axes, zonesOn: this.modes.zones }
      if (left.length) this.areas.set(this.here, { ...this.area, bubbles: left.map(b => ({ ...b, vx: 0, vy: 0, goal: undefined })), links: this.links, words: [...this.linkWords], history: this.history, overlay })
      else { this.areas.delete(this.here); this.names.delete(this.here) }
      const to = this.areas.get(key)
      this.areas.delete(key)
      this.bubbles = to?.bubbles ?? []
      this.links = to?.links ?? []
      this.linkWords = new Map(to?.words ?? [])
      this.history = to?.history ?? []
      const o = to?.overlay ?? PLAIN()
      this.zoneEditor.zones = o.zones
      this.manualZones = o.manualZones
      this.labels = o.labels
      this.modes.axes = o.axes
      this.modes.zones = o.zonesOn
      this.area = { col, row }
      this.onEvent?.('dive', { col, row, fresh: !to })
    }
    if (this.overview) this.onEvent?.('overview', { on: false })
    this.overview = false
  }

  /**
   * The overview's tiles: every area with ideas in it, the one on screen, and a ring of empty
   * ones around them to continue into. Laid out inside the part of the board hands can reach.
   */
  cells(): Cell[] {
    const used = [...this.areas.values(), this.area]
    const c0 = Math.min(...used.map(a => a.col)) - 1, c1 = Math.max(...used.map(a => a.col)) + 1
    const r0 = Math.min(...used.map(a => a.row)) - 1, r1 = Math.max(...used.map(a => a.row)) + 1
    const cols = c1 - c0 + 1, rows = r1 - r0 + 1, s = Math.min(1 / cols, 1 / rows)
    const { x0, y0, x1, y1 } = this.bounds
    const w = (x1 - x0) * s, h = (y1 - y0) * s
    const ox = x0 + (x1 - x0 - cols * w) / 2, oy = y0 + (y1 - y0 - rows * h) / 2
    const out: Cell[] = []
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
      const key = `${col},${row}`, current = key === this.here, kept = this.areas.get(key), name = this.names.get(key)
      out.push({
        key, col, row, current, x0: ox + (col - c0) * w, y0: oy + (row - r0) * h, x1: ox + (col - c0 + 1) * w, y1: oy + (row - r0 + 1) * h,
        bubbles: current ? this.bubbles.filter(b => !b.leaving) : kept?.bubbles ?? [], links: current ? this.links : kept?.links ?? [],
        name: name?.text, emoji: name?.emoji,
      })
    }
    return out
  }

  /** The overview tile at this point of the board. */
  cellAt(x: number, y: number): Cell | undefined {
    return this.cells().find(c => x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1)
  }

  /**
   * Two fists on the canvas itself. Pushed together in the work view they zoom out; pulled
   * apart in the overview they go into the area between them. Returns whether the view changed.
   */
  private canvas(hands: Hand[], t: number): boolean {
    const hold = this.canvasHold
    if (hold) {
      const a = hands.find(h => h.id === hold.hands[0]), b = hands.find(h => h.id === hold.hands[1])
      if (!a || !b || a.gesture !== 'fist' || b.gesture !== 'fist') { this.canvasHold = undefined; return false }
      hold.now = this.dist(a.x, a.y, b.x, b.y)
      if (!this.overview && hold.now <= hold.dist - CANVAS_PULL) { this.setOverview(true); return this.overview }
      if (this.overview && hold.now >= hold.dist + CANVAS_PULL) {
        const cell = this.cellAt((a.x + b.x) / 2, (a.y + b.y) / 2)
        if (cell) { this.dive(cell.col, cell.row); return true }
      }
      return false
    }
    // In the work view only fists on empty space count: ones waiting to become a new idea, or one that just did.
    const free = (h: Hand) => {
      if (h.gesture !== 'fist' || h.resting || this.spent.has(h.id)) return false
      if (this.overview) return true
      const st = this.hands.get(h.id)
      return !!st && !st.bubble && (st.aim?.kind === 'idea' || (st.idea && !st.branchFrom))
    }
    // Both fists are one person's: two people each closing a fist are each starting their own idea.
    const fists = hands.filter(free)
    const a = fists.find((h, i) => fists.some((o, j) => j > i && o.person === h.person))
    const b = a && fists.find(o => o !== a && o.person === a.person)
    const closed = (h: Hand) => this.hands.get(h.id)?.fistAt ?? 0
    if (!a || !b || (!this.overview && Math.abs(closed(a) - closed(b)) > CANVAS_JOIN_MS) || this.deleting || this.structuring || this.asks.size > 0) return false
    for (const h of [a, b]) {
      const st = this.hands.get(h.id)
      if (!st) continue
      if (st.idea) this.endIdea(h.id, st, undefined, t, 'held the canvas instead')
      st.aim = undefined
      this.aims.delete(h.id)
    }
    const dist = this.dist(a.x, a.y, b.x, b.y)
    this.canvasHold = { hands: [a.id, b.id], dist, now: dist }
    return false
  }

  update(input: PlayInput) {
    const { t, hands } = input
    const dt = Math.min(0.1, Math.max(0, (t - (this.lastT ?? t)) / 1000))
    this.lastT = t
    this.shapes = new Map(hands.map(h => [h.id, h.gesture]))
    for (const [id, shape] of this.spent) if (this.shapes.get(id) !== shape) this.spent.delete(id)

    if (this.overview) {
      // Nothing moves and nothing is edited: hands only choose where to go.
      const live = hands.filter(h => !h.resting)
      if (this.canvas(live, t)) return
      const p = this.canvasHold ? undefined : live.find(h => h.gesture === 'point' && !this.spent.has(h.id))
      const cell = p && this.cellAt(p.tipX, p.tipY)
      if (!p || !cell) this.overviewAim = undefined
      else if (this.overviewAim?.key !== cell.key || this.overviewAim.hand !== p.id) this.overviewAim = { key: cell.key, since: t, hand: p.id }
      else if (t - this.overviewAim.since >= DIVE_MS) this.dive(cell.col, cell.row)
      return
    }

    if (this.zoneEditor.editing) {
      const { x0, x1, y0, y1 } = this.bounds
      // A fist draws and a thumbs-down deletes with the hand's middle (a curled fingertip wanders); a pointing finger names with its tip.
      this.zoneEditor.update(hands.filter(h => !h.resting).map(h => {
        const aim = h.gesture === 'fist' || h.gesture === 'thumbDown' ? h : { x: h.tipX, y: h.tipY }
        return { ...h, tipX: (aim.x - x0) / (x1 - x0), tipY: (aim.y - y0) / (y1 - y0) }
      }), t)
      return
    }

    if (this.deleting && t - this.deleteSince >= DELETE_IDLE_MS) this.setDeleting(false, 'idle')

    const present = new Set(hands.map(h => h.id))
    for (const [id, st] of this.hands) {
      if (present.has(id)) continue
      if (st.idea) {
        // Lowering the arm takes the hand out of view before it opens. A new idea that was held a moment stays where it was.
        const idea = this.ideas.get(id)
        this.endIdea(id, st, !st.branchFrom && t - st.ideaSince >= IDEA_KEEP_MS ? idea : undefined, t)
      }
      if (st.bubble) this.release(id, st, undefined, t)
      this.endAsk(id, t) // a lost hand still sends what it asked
      this.hands.delete(id)
      this.aims.delete(id)
    }
    this.raised(hands, t, input.raised)
    for (const h of hands) if (!this.canvasHold?.hands.includes(h.id)) this.hand(h, t)
    if (!this.zoneEditor.editing && this.canvas(hands, t)) return
    this.applyHolds(hands)
    this.physics(dt)
  }

  /** Where a hand takes hold: its middle. */
  private at(h: Hand) {
    return { x: h.x, y: h.y }
  }

  /** Both open hands held high: listen for how to organise the board until they come down. */
  private raised(hands: Hand[], t: number, pose?: boolean) {
    const open = (h: Hand) => h.gesture === 'palm' || h.gesture === 'none'
    // The body pose says whether the hands are above the head, wherever that falls on the
    // board; without it, fall back to both hands in the top of the board.
    const up = pose ?? hands.filter(h => h.y < RAISE_Y).length >= 2
    if (!this.structuring) {
      const busy = this.ideas.size > 0 || this.asks.size > 0 || !!this.canvasHold || this.bubbles.some(b => b.holders.length > 0)
      if (!busy && up && hands.every(open)) {
        this.raisedAt ??= t
        if (t - this.raisedAt >= RAISE_MS) this.setStructuring(true)
      } else this.raisedAt = undefined
    } else if (pose ?? hands.filter(h => h.y < RAISE_Y + 0.12).length >= 2) this.loweredAt = undefined
    else {
      // A moment's grace, so one dropped frame doesn't cut the speaker off.
      this.loweredAt ??= t
      if (t - this.loweredAt >= LOWER_MS) this.setStructuring(false)
    }
  }

  /** Start or stop listening for how to organise the board (hands, or a key). */
  setStructuring(on: boolean) {
    if (on && (this.zoneEditor.editing || this.deleting || this.overview)) return
    if (on === this.structuring) return
    this.structuring = on
    this.raisedAt = undefined
    this.loweredAt = undefined
    this.onEvent?.(on ? 'structureStart' : 'structureEnd', {})
    this.onRequest?.({ kind: on ? 'structureStart' : 'structureEnd' })
  }

  /**
   * Whether this hand may start something that listens. With one microphone, only while nothing
   * else is listening. With one each, a person waits only for their own idea or question.
   */
  private quiet(h: Hand): boolean {
    const listening = [...this.ideas.keys(), ...this.asks.keys()]
    if (this.voices < 2 || h.person === undefined) return listening.length === 0
    return !listening.some(id => { const p = this.hands.get(id)?.person; return p === undefined || p === h.person })
  }

  /** Inside the part of the picture the board covers: a fist below or beside it is a hand being lowered, not an idea. */
  private onBoard(h: Hand) {
    const { x0, y0, x1, y1 } = this.bounds
    return h.x >= x0 && h.x <= x1 && h.y >= y0 && h.y <= y1
  }

  private hand(h: Hand, t: number) {
    let st = this.hands.get(h.id)
    if (!st) { st = { offX: 0, offY: 0, idea: false, ideaSince: 0, x: h.x, y: h.y, gesture: 'none', thumbDone: false }; this.hands.set(h.id, st) }
    if (h.gesture !== 'fist') st.opened = true
    st.x = this.at(h).x
    st.y = this.at(h).y
    st.person = h.person
    if (this.spent.has(h.id)) { st.gesture = h.gesture; return } // still as it was when the view changed
    const changed = st.gesture !== h.gesture
    if (changed) st.thumbDone = false
    if (changed && h.gesture === 'fist') st.fistAt = t

    const asking = this.asks.get(h.id)
    if (asking) {
      // The sign is still up after asking: the hand does nothing else until it is lowered, which sends the ask.
      const over = t - asking.since >= ASK_MAX_MS
      if (h.gesture === 'victory' && !over) asking.lostAt = undefined
      else {
        asking.lostAt ??= t
        if (over || t - asking.lostAt >= ASK_GRACE_MS) {
          this.endAsk(h.id, t)
          // A sign still up when the ask sent itself must come down before it can ask again.
          st.asked = h.gesture === 'victory'
        }
      }
      st.aim = undefined
      this.aims.delete(h.id)
      st.gesture = h.gesture
      return
    }

    if (this.deleting) {
      // A finger shaken from side to side puts the fire out.
      let shake = this.shakes.get(h.id)
      if (!shake) { shake = new Shake(); this.shakes.set(h.id, shake) }
      if (!h.resting && shake.update(h.tipX, t)) {
        st.gesture = h.gesture
        this.setDeleting(false, 'shake')
        return
      }
      const still = Math.hypot(h.vx, h.vy) <= BURN_STILL
      const b = h.gesture === 'point' && !h.resting && still ? this.bubbleAt(h.tipX, h.tipY) : undefined
      if (!b || b.pending) st.aim = undefined
      else if (st.aim?.bubble !== b.id || st.aim.kind !== 'burn') st.aim = { bubble: b.id, since: t, kind: 'burn' }
      else if (t - st.aim.since >= BURN_MS) {
        st.aim = undefined
        this.checkpoint()
        this.detach(b)
        b.leaving = 'burn'; b.leftAt = t; b.vx = 0; b.vy = 0
        this.deleteSince = t
        this.onEvent?.('bin', { hand: h.id, bubble: b.id, text: b.text, starred: b.starred, mode: 'delete' })
      }
      if (st.aim) this.aims.set(h.id, st.aim)
      else this.aims.delete(h.id)
      st.gesture = h.gesture
      return
    }

    // A hand at rest, or any hand while the board is listening to be organised, starts nothing.
    // It can still finish what it is holding.
    const idle = !!h.resting || this.structuring
    const aiming = (h.gesture === 'point' || h.gesture === 'victory') && !idle
    const holding = h.gesture === 'fist'
    if ((!aiming && h.gesture !== 'fist') || st.idea || st.bubble || idle) st.aim = undefined
    if (h.gesture !== 'victory') st.asked = false
    if (st.idea && t - st.ideaSince >= IDEA_MAX_MS) this.endIdea(h.id, st, undefined, t, 'too long')
    if (st.idea) {
      const idea = this.ideas.get(h.id)!
      if (!st.branchFrom) {
        // A new idea rides in the fist and is placed by opening it.
        idea.x = h.x; idea.y = h.y
        if (h.gesture !== 'fist') this.endIdea(h.id, st, idea, t, undefined, Math.hypot(h.vx, h.vy))
      } else {
        // A branch rides on the fingertip. An open palm plants it where the fingertip was,
        // or cancels it if it was never pulled clear of the bubble it came from.
        const p = this.byId(st.branchFrom)
        if (h.gesture === 'point') {
          idea.x = h.tipX; idea.y = h.tipY
          // Landing the shoot on another bubble offers to connect the two instead.
          const over = this.bubbleAt(idea.x, idea.y, p)
          idea.over = over && !over.pending ? over.id : undefined
        }
        if (h.gesture === 'palm') {
          const pulledOut = !p || this.dist(idea.x, idea.y, p.x, p.y) > R * p.scale
          const spoke = this.heard.has(h.id)
          // A silent shoot that stops within a bubble's radius of another bubble's rim was a connection that missed:
          // with nothing said it could only have left an empty bubble.
          const near = pulledOut ? this.nearest(idea.x, idea.y, p) : undefined
          const target = this.byId(idea.over) ?? (!spoke && near && near.gap <= R ? near.bubble : undefined)
          this.onEvent?.('branchEnd', { hand: h.id, from: p?.id, x: +idea.x.toFixed(2), y: +idea.y.toFixed(2), over: idea.over, near: near?.bubble.id, gap: near && +near.gap.toFixed(3), spoke, pulledOut })
          // Someone who has been saying an idea while pointing meant the idea: their fingertip drifting
          // onto another bubble is not a connection. Connecting is done without speaking.
          if (p && target && !spoke) {
            this.endIdea(h.id, st, undefined, t, 'connected instead')
            this.connect(p, target)
          } else this.endIdea(h.id, st, pulledOut ? idea : undefined, t, pulledOut ? undefined : 'put back')
        }
      }
    } else if (holding) {
      const here = this.at(h)
      if (st.bubble || idle) {
        // already holding, or not allowed to start anything
      } else if (changed) {
        // A second hand joins whatever the other is holding, wherever it is: the hands
        // don't have to fit on the bubble together (up close, one would hide the other).
        // Only the same person's other hand: someone else's fist is their own move.
        const heldByOther = this.bubbles.find(k => k.holders.length === 1 && k.holders[0] !== h.id && this.hands.get(k.holders[0])?.person === h.person)
        const found = heldByOther ?? this.grabbable(here.x, here.y)
        // A bubble in someone else's hand is theirs until they let go.
        const b = found?.holders.some(id => this.hands.get(id)?.person !== h.person) ? undefined : found
        if (b) {
          this.grab(b, h, st)
          // The other fist closed on empty space a moment ago: it was the same two-handed grab.
          for (const [id, other] of this.hands) {
            if (id === h.id || other.person !== h.person || other.aim?.kind !== 'idea' || t - other.aim.since > JOIN_MS || b.holders.length >= 2) continue
            other.aim = undefined
            this.aims.delete(id)
            other.bubble = b.id
            b.holders.push(id)
          }
        } else if (!found && h.gesture === 'fist') st.aim = { bubble: '', since: t, kind: 'idea' }
      } else if (h.gesture === 'fist' && st.aim?.kind === 'idea' && t - st.aim.since >= (st.opened ? IDEA_DWELL_MS : IDEA_ARRIVED_MS) && this.onBoard(h) && this.quiet(h)) {
        // The fist has stayed closed on empty space: that is a new idea, not a missed grab.
        // One idea at a time for each microphone.
        st.aim = undefined
        this.startIdea(h, st, undefined, t)
      }
    } else if (st.bubble) {
      this.release(h.id, st, h, t)
    } else if (aiming) {
      // A fingertip that comes to rest on a bubble, however it got there: one finger starts a
      // branch, two fingers ask Claude for more.
      const kind = h.gesture === 'point' ? 'branch' : 'ask'
      const on = this.bubbleAt(h.tipX, h.tipY)
      // Two fingers on a connection's knot ask about the pair.
      const pair = !on && kind === 'ask' ? this.knotAt(h.tipX, h.tipY) : undefined
      const b = on ?? pair?.[0], other = pair?.[1]
      const busy = (k?: Bubble) => !!k && (k.pending || k.holders.length > 0)
      // Nothing that listens starts while something else is listening on the same microphone.
      const quiet = this.quiet(h)
      if (!b || busy(b) || busy(other) || (kind === 'ask' && st.asked)) st.aim = undefined
      else if (st.aim?.bubble !== b.id || st.aim.other !== other?.id || st.aim.kind !== kind) st.aim = { bubble: b.id, since: t, kind, ...(other ? { other: other.id } : {}) }
      else if (kind === 'branch') {
        if (t - st.aim.since >= POINT_DWELL_MS && quiet) { st.aim = undefined; this.startIdea(h, st, b.id, t) }
      } else if (t - st.aim.since >= ASK_DWELL_MS && quiet) {
        st.aim = undefined
        st.asked = true
        this.startAsk(h.id, b, other, t)
      }
    }
    if (st.aim) this.aims.set(h.id, st.aim)
    else this.aims.delete(h.id)

    if ((h.gesture === 'thumbUp' || h.gesture === 'thumbDown') && !idle && !st.thumbDone && t - h.gestureSince >= THUMB_HOLD_MS) {
      // Only a thumb held on a bubble counts: a resting hand often looks like a thumbs-down.
      const b = this.grabbable(h.x, h.y)
      if (b) {
        this.checkpoint()
        if (h.gesture === 'thumbUp') b.starred = !b.starred
        else { this.detach(b); b.leaving = 'bin'; b.vx = 0; b.vy = 0.4 }
        this.onEvent?.(h.gesture === 'thumbUp' ? 'star' : 'bin', { hand: h.id, bubble: b.id, text: b.text, starred: b.starred })
        st.thumbDone = true
      }
    }
    st.gesture = h.gesture
  }

  private startIdea(h: Hand, st: HandState, parent: string | undefined, t: number) {
    st.idea = true
    st.ideaSince = t
    st.branchFrom = parent
    this.ideas.set(h.id, parent ? { parent, x: h.tipX, y: h.tipY } : { x: h.x, y: h.y })
    this.onEvent?.('ideaStart', { hand: h.id, branchFrom: parent })
    this.onRequest?.({ kind: 'listenStart', hand: h.id })
  }

  /** Place the idea at `at`, or abandon it (the hand has gone, or it was put back). */
  private endIdea(id: number, st: HandState, h: { x: number; y: number } | undefined, t: number, why?: string, speed?: number) {
    const parent = this.byId(st.branchFrom)
    st.idea = false
    st.branchFrom = undefined
    this.ideas.delete(id)
    this.onEvent?.(h ? 'ideaPlaced' : 'ideaAbandoned', { hand: id, branchFrom: parent?.id, heldMs: Math.round(t - st.ideaSince), speed: speed === undefined ? undefined : +speed.toFixed(2), why: h ? undefined : why ?? 'hand lost' })
    if (!h) { this.onRequest?.({ kind: 'listenEnd', hand: id }); return }
    this.checkpoint()
    const b = this.bubble('…', '💡', parent?.colour ?? this.rootColour(), h.x, h.y, t)
    b.parent = parent?.id
    b.pending = true
    if (parent) b.scale = 0.85
    // How it is put down says how sure you are: set down gently it is small, thrown down it is big.
    else if (speed !== undefined) b.scale = Math.min(1.5, Math.max(0.8, 0.8 + speed * 0.5))
    this.bubbles.push(b)
    if (this.onRequest) this.onRequest({ kind: 'listenEnd', hand: id, bubbleId: b.id })
    else this.setText(b.id, ...this.spare())
  }

  /** Placeholder words for an idea when nothing can hear it. */
  spare(): [string, string] {
    return SPARE[this.nextSpare++ % SPARE.length]
  }

  private grab(b: Bubble, h: Hand, st: HandState) {
    st.bubble = b.id
    st.offX = b.x - this.at(h).x
    st.offY = b.y - this.at(h).y
    if (b.holders.length === 0) {
      this.checkpoint()
      this.bubbles = [...this.bubbles.filter(k => k !== b), b] // bring to the front
    }
    b.holders.push(h.id)
    b.vx = b.vy = 0
    b.goal = undefined
    this.gather(b)
    this.onEvent?.('grab', { hand: h.id, bubble: b.id, text: b.text, hands: b.holders.length, with: h.gesture })
  }

  private release(id: number, st: HandState, h: Hand | undefined, t: number) {
    const b = this.byId(st.bubble)
    st.bubble = undefined
    if (!b) return
    b.holders = b.holders.filter(x => x !== id)
    const s = this.stretch.get(b.id)
    this.stretch.delete(b.id)
    if (b.holders.length > 0) {
      // The end of a two-handed hold. On the workbench the shape it was pulled into becomes a new version.
      this.onEvent?.('twoHandEnd', { hand: id, bubble: b.id, from: s?.scale, to: +b.scale.toFixed(2), hint: b.hint, workbench: this.modes.workbench })
      if (s && this.modes.workbench) {
        const how = b.hint
        b.scale = s.scale
        b.opened = b.scale >= OPEN_AT
        if (how && !b.pending) this.variant(b, how, t)
      }
      b.hint = undefined
      // The other hand keeps it; re-anchor so it doesn't jump.
      const other = this.hands.get(b.holders[0])
      if (other) { other.offX = b.x - other.x; other.offY = b.y - other.y }
      return
    }
    b.hint = undefined
    const target = this.byId(b.mergeInto)
    b.mergeInto = undefined
    const speed = h ? +Math.hypot(h.vx, h.vy).toFixed(2) : undefined
    this.onEvent?.(target && h ? 'merge' : speed !== undefined && speed >= FLING_SPEED ? 'fling' : 'drop',
      { hand: id, bubble: b.id, text: b.text, into: target?.text, speed, handLost: !h, x: +b.x.toFixed(2), y: +b.y.toFixed(2) })
    // Only a deliberate drop merges. If the camera lost the hand, the bubble just stays where it was.
    if (target && h) return this.merge(b, target)
    if (h && Math.hypot(h.vx, h.vy) >= FLING_SPEED) {
      b.vx = h.vx
      b.vy = h.vy
      // With zones on, a throw sends it across the board; otherwise it is thrown away.
      if (!this.modes.zones) { this.detach(b); b.leaving = 'fling' }
    }
  }

  /** Unhook a bubble that is going away: hands let go, and its branches attach to its own parent. */
  private detach(b: Bubble) {
    for (const st of this.hands.values()) if (st.bubble === b.id) st.bubble = undefined
    for (const k of this.bubbles) {
      if (k.parent === b.id) k.parent = b.parent
      if (k.mergeInto === b.id) k.mergeInto = undefined
    }
    b.holders = []
    b.parent = undefined
    b.mergeInto = undefined
    b.hint = undefined
    this.stretch.delete(b.id)
    this.links = this.links.filter(l => !l.includes(b.id))
  }

  /** `a` was dropped onto `b`: they become one idea, where `b` is. */
  private merge(a: Bubble, b: Bubble) {
    const idea = a.text, other = b.text
    if (b.parent === a.id) b.parent = a.parent
    // Everything attached to `a` now belongs to the merged idea, and takes its colour.
    for (const k of this.bubbles) if (k.parent === a.id && k !== b) k.parent = b.id
    // What hung off a knot of `a` hangs off the merged idea's; a knot can't join an idea to itself.
    for (const k of this.bubbles) {
      if (!k.knot) continue
      const [p, q] = k.knot.map(id => id === a.id ? b.id : id)
      k.knot = p === q || p === k.id || q === k.id ? undefined : [p, q]
    }
    // ...and so does the angle written on each of its lines, unless the merged idea's line already has one.
    for (const [key, word] of [...this.linkWords]) {
      const ends = key.split('|')
      if (!ends.includes(a.id)) continue
      this.linkWords.delete(key)
      const [p, q] = ends.map(id => id === a.id ? b.id : id)
      const moved = [p, q].sort().join('|')
      if (p !== q && !this.linkWords.has(moved)) this.linkWords.set(moved, word)
    }
    const links = this.links.map(([p, q]) => [p === a.id ? b.id : p, q === a.id ? b.id : q] as [string, string])
    this.detach(a)
    this.links = links.filter(([p, q], i) => p !== q && links.findIndex(([r, s]) => (r === p && s === q) || (r === q && s === p)) === i)
    this.bubbles = this.bubbles.filter(k => k !== a)
    this.recolour(b)
    b.scale = Math.min(2.6, Math.hypot(a.scale, b.scale))
    b.starred = b.starred || a.starred
    b.full = `${other} + ${idea}`
    this.ask(b, 'combine', idea, other)
  }

  /** Connect two ideas, or disconnect them if they already are. */
  private connect(a: Bubble, b: Bubble) {
    if (a.parent === b.id || b.parent === a.id) return // already joined as branch and parent
    this.checkpoint()
    const at = this.links.findIndex(([p, q]) => (p === a.id && q === b.id) || (p === b.id && q === a.id))
    if (at >= 0) { this.links.splice(at, 1); this.linkWords.delete([a.id, b.id].sort().join('|')) }
    else this.links.push([a.id, b.id])
    this.onEvent?.(at >= 0 ? 'disconnect' : 'connect', { a: a.text, b: b.text })
  }

  /**
   * A hub is a bubble with HUB_MIN or more connections. A victory sign on it asks about it and
   * everything connected to it together; this is those connected bubbles (none if `b` is no hub).
   */
  hub(b?: Bubble): Bubble[] {
    if (!b) return []
    const linked = this.links.filter(l => l.includes(b.id)).map(([p, q]) => this.byId(p === b.id ? q : p)).filter((k): k is Bubble => !!k && !k.leaving && !k.pending)
    return linked.length >= HUB_MIN ? linked : []
  }

  /** A new pending branch beside `b`, clear of the branches it already has. */
  private sprout(b: Bubble, t: number): Bubble {
    const n = this.bubbles.filter(k => k.parent === b.id).length
    const angle = -Math.PI / 4 + n * 1.1
    const reach = R * b.scale + R * 0.85 + BRANCH_GAP
    const v = this.bubble('…', '✨', b.colour, b.x + Math.cos(angle) * reach / this.aspect, b.y + Math.sin(angle) * reach, t)
    v.parent = b.id
    v.scale = 0.85
    v.byClaude = true
    this.bubbles.push(v)
    return v
  }

  /** A new pending bubble hanging off the knot between `a` and `b`, to one side of the line and clear of the ones already there. */
  private sproutBetween(a: Bubble, b: Bubble, colour: string, t: number): Bubble {
    const n = this.bubbles.filter(k => this.hangsOn(k, a, b)).length
    const k = this.knot(a, b)
    // Across the line, in board heights: alternate sides, and step outward as it fills up.
    const dx = (b.x - a.x) * this.aspect, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1
    const side = n % 2 ? 1 : -1
    const reach = (R * KNOT_CLEAR + R * 0.85 + LINK_GAP + Math.floor(n / 2) * R * 1.8) * side
    const v = this.bubble('…', '✨', colour, k.x + (-dy / d) * reach / this.aspect, k.y + (dx / d) * reach, t)
    v.knot = [a.id, b.id]
    v.scale = 0.85
    v.byClaude = true
    this.bubbles.push(v)
    return v
  }

  private hangsOn(k: Bubble, a: Bubble, b: Bubble) {
    return !k.leaving && !!k.knot && k.knot.includes(a.id) && k.knot.includes(b.id)
  }

  /**
   * A victory sign settled on `b`, or on the knot between `b` and `other`: put out the new bubbles
   * and start listening for an angle. The ask goes to Claude when the sign is lowered (endAsk).
   */
  private startAsk(hand: number, b: Bubble, other: Bubble | undefined, t: number) {
    this.checkpoint()
    const nearby = this.contextBubbles(b)
    // On a hub itself (not on one of its knots), everything connected to it feeds the ask, whatever zone it sits in.
    const hub = other ? [] : this.hub(b)
    let branches: Bubble[], around: Bubble[], made: Bubble[]
    if (other) {
      branches = this.bubbles.filter(k => !k.pending && this.hangsOn(k, b, other))
      around = [...new Set([...nearby, ...this.contextBubbles(other)])].filter(k => k !== b && k !== other && !branches.includes(k))
      // What grows from a pair is a family of its own.
      const colour = branches[0]?.colour ?? this.rootColour()
      made = Array.from({ length: SUGGESTIONS }, () => this.sproutBetween(b, other, colour, t))
    } else {
      branches = nearby.filter(k => k.parent === b.id)
      around = nearby.filter(k => k !== b && k.parent !== b.id && !hub.includes(k))
      made = Array.from({ length: SUGGESTIONS }, () => this.sprout(b, t))
    }
    for (const v of made) v.pending = true
    this.asks.set(hand, {
      bubble: b.id, other: other?.id, since: t, made: made.map(v => v.id), idea: b.text, otherIdea: other?.text,
      linkedIds: hub.map(k => k.id), linked: hub.map(k => k.text),
      branches: branches.map(k => k.text), board: around.map(k => k.text),
      ...(this.modes.zones ? { zone: this.zoneAt(b)?.name ?? 'Outside zones' } : {}),
    })
    this.onEvent?.('ask', { hand, bubble: b.id, text: b.text, other: other?.text, ...(hub.length ? { linked: hub.map(k => k.text) } : {}) })
    this.onRequest?.({ kind: 'askStart', hand })
  }

  /** The sign came down (or the hand was lost): send the ask. Cancelled, its new bubbles are taken back instead. */
  private endAsk(hand: number, t: number, cancelled = false) {
    const a = this.asks.get(hand)
    if (!a) return
    this.asks.delete(hand)
    const made = a.made.filter(id => this.byId(id))
    this.onEvent?.(cancelled ? 'askCancelled' : 'askEnd', { hand, bubble: a.bubble, heldMs: Math.round(t - a.since) })
    if (cancelled || made.length === 0) {
      for (const id of made) this.remove(id)
      this.onRequest?.({ kind: 'listenEnd', hand })
    } else if (this.onRequest) {
      this.onRequest({ kind: 'suggest', hand, bubbleIds: made, idea: a.idea, ...(a.otherIdea !== undefined ? { other: a.otherIdea } : {}), ...(a.linked.length ? { linked: a.linked } : {}), branches: a.branches, board: a.board, ...(a.zone !== undefined ? { zone: a.zone } : {}) })
    } else made.forEach((id, i) => this.setText(id, `Another angle ${i + 1}`))
  }

  private cancelAsks() {
    for (const hand of [...this.asks.keys()]) this.endAsk(hand, this.lastT ?? 0, true)
  }

  /** Claude said which angle it answered for these new bubbles: keep it behind each, and on the line if they hang off a knot. */
  setAngle(bubbleIds: string[], angle: string) {
    const word = angle.trim()
    if (!word) return
    for (const id of bubbleIds) {
      const b = this.find(id)
      if (!b) continue
      // Its area may have been left while Claude was answering.
      const kept = this.byId(id) ? undefined : [...this.areas.values()].find(a => a.bubbles.includes(b))
      const from = b.knot ? b.knot.map(k => this.find(k)?.text).filter(Boolean).join(' + ') : this.find(b.parent)?.text
      if (from) b.full = `${word}: ${from}`
      if (!b.knot) continue
      const key = [...b.knot].sort().join('|')
      if (kept) kept.words = [...kept.words.filter(([k]) => k !== key), [key, word]]
      else this.linkWords.set(key, word)
    }
  }

  /**
   * Organise the board the way Claude read the spoken request: label the axes or zones,
   * turn that overlay on, and send each bubble gliding to its place. Undoable.
   */
  applyStructure(s: Structure) {
    if (s.kind === 'none') return
    this.checkpoint()
    this.zoneEditor.setEditing(false)
    this.manualZones = false
    this.zoneEditor.zones = []
    this.onEvent?.('structure', { ...s })
    if (s.kind === 'clear') { this.modes.axes = false; this.modes.zones = false; return }
    if (s.kind === 'axes') {
      this.labels.x = s.x
      this.labels.y = s.y
      this.modes.axes = true
      this.modes.zones = false
      for (const p of s.place) {
        const b = this.byId(p.id)
        // The plot area the axes overlay draws: left to right, and bottom to top.
        if (b && !b.leaving) { b.goal = this.within(0.12 + 0.78 * p.x, 0.8 - 0.62 * p.y); b.loose = true }
      }
    } else {
      const n = s.zones.length
      this.labels.zones = s.zones
      this.modes.zones = true
      this.modes.axes = false
      const filled = new Array(n).fill(0)
      for (const p of s.place) {
        const b = this.byId(p.id)
        if (!b || b.leaving || p.zone < 0 || p.zone >= n) continue
        const k = filled[p.zone]++
        // Two columns inside each zone, filling downward.
        b.goal = n > 4
          ? this.within((p.zone + 0.5) / n, 0.3 + k * 0.14)
          : this.within((p.zone + 0.3 + 0.4 * (k % 2)) / n, 0.32 + Math.floor(k / 2) * 0.19)
        b.loose = true
      }
    }
  }

  /**
   * Tidy the board without changing any words: each connected group is laid out round its busiest
   * bubble (what is joined to it in a ring, what grew from those fanning outward), groups sit side
   * by side, and bubbles joined to nothing line up along the bottom. Undo takes it back.
   */
  tidy(): boolean {
    const all = this.bubbles.filter(b => !b.leaving)
    if (all.length === 0 || this.manualZones || this.zoneEditor.editing || this.overview) return false
    this.checkpoint()
    this.modes.axes = this.modes.zones = false
    const byId = new Map(all.map(b => [b.id, b]))
    const next = new Map<string, Set<string>>(all.map(b => [b.id, new Set<string>()]))
    const join = (a?: string, b?: string) => { if (a && b && a !== b && next.has(a) && next.has(b)) { next.get(a)!.add(b); next.get(b)!.add(a) } }
    for (const b of all) { join(b.id, b.parent); join(b.id, b.knot?.[0]); join(b.id, b.knot?.[1]) }
    for (const [a, b] of this.links) join(a, b)

    // Each group as a tree from its busiest bubble. What hangs off a knot goes beyond the knot's outer end.
    type Node = { b: Bubble; depth: number; kids: Node[]; leaves: number }
    const seen = new Set<string>()
    const groups: { root: Node; nodes: Node[] }[] = []
    for (const start of [...all].sort((p, q) => next.get(q.id)!.size - next.get(p.id)!.size)) {
      if (seen.has(start.id)) continue
      const root: Node = { b: start, depth: 0, kids: [], leaves: 1 }
      const nodes = [root], at = new Map([[start.id, root]]), expanded = new Set<string>()
      seen.add(start.id)
      const later: [Node, Bubble][] = []
      const attach = (from: Node, k: Bubble) => {
        const node: Node = { b: k, depth: from.depth + 1, kids: [], leaves: 1 }
        from.kids.push(node); nodes.push(node); at.set(k.id, node); seen.add(k.id)
      }
      for (let i = 0; i < nodes.length || later.length; i++) {
        if (i >= nodes.length) { // only held-back knot bubbles are left: attach one where it was first met
          const [from, k] = later.shift()!
          if (!at.has(k.id)) attach(from, k)
          i--
          continue
        }
        const from = nodes[i]
        expanded.add(from.b.id)
        for (const id of next.get(from.b.id)!) {
          const k = byId.get(id)!
          if (at.has(id)) continue
          const other = k.knot?.includes(from.b.id) ? at.get(k.knot[0] === from.b.id ? k.knot[1] : k.knot[0]) : undefined
          const end = k.knot?.includes(from.b.id) ? byId.get(k.knot[0] === from.b.id ? k.knot[1] : k.knot[0]) : undefined
          // From the knot's inner end, wait: the outer end takes it.
          if (end && (!other || other.depth > from.depth || (other.depth === from.depth && !expanded.has(end.id)))) { later.push([from, k]); continue }
          attach(from, k)
        }
      }
      const count = (n: Node): number => n.leaves = n.kids.length ? n.kids.reduce((sum, k) => sum + count(k), 0) : 1
      count(root)
      groups.push({ root, nodes })
    }

    const A = this.aspect, { x0, y0, x1, y1 } = this.bounds
    const step = R * 1.85 + BRANCH_GAP, WIDE = 1.25 // rings are wider than tall: screens are
    const singles = groups.filter(g => g.nodes.length === 1), trees = groups.filter(g => g.nodes.length > 1)
    // How far out each ring sits (in board heights): a step beyond the last, or further if it is crowded.
    const rings = (g: { nodes: Node[] }, s: number) => {
      const per: number[] = []
      for (const n of g.nodes) per[n.depth] = (per[n.depth] ?? 0) + 1
      const r = [0]
      for (let d = 1; d < per.length; d++) r[d] = Math.max(r[d - 1] + step * s, per[d] * (R * 1.8 + PAD) / (2 * Math.PI * ((1 + WIDE) / 2)))
      return r
    }
    const rowH = singles.length ? R * 2 + 0.04 : 0
    const availW = (x1 - x0) * A, availH = y1 - y0 - rowH
    const extent = (s: number) => trees.map(g => { const r = rings(g, s).at(-1)!; return { rx: r * WIDE + R, ry: r + R } })
    const GAP = 0.05
    let s = 1
    for (let i = 0; i < 6; i++) { // shrink the rings (never the bubbles) until the groups fit
      const e = extent(s)
      const wide = e.reduce((sum, k) => sum + 2 * k.rx, 0) + GAP * Math.max(0, e.length - 1), tall = Math.max(0, ...e.map(k => 2 * k.ry))
      if ((wide <= availW && tall <= availH) || s <= 0.55) break
      s = Math.max(0.55, s * Math.min(availW / wide, availH / tall, 0.95))
    }
    const e = extent(s)
    const wide = e.reduce((sum, k) => sum + 2 * k.rx, 0) + GAP * Math.max(0, e.length - 1)
    const send = (b: Bubble, x: number, y: number) => {
      b.goal = { x: Math.min(x1 - R / A, Math.max(x0 + R / A, x)), y: Math.min(y1 - R, Math.max(y0 + R, y)) }
      b.vx = b.vy = 0
      b.loose = false
    }
    let left = x0 * A + Math.max(0, (availW - wide) / 2) // in board heights from the left edge
    const midY = y0 + availH / 2
    trees.forEach((g, i) => {
      const r = rings(g, s), cx = left + e[i].rx
      left += 2 * e[i].rx + GAP
      const place = (n: Node, a0: number, a1: number) => {
        const a = (a0 + a1) / 2
        send(n.b, (cx + Math.cos(a) * r[n.depth] * WIDE) / A, midY + Math.sin(a) * r[n.depth])
        // Below the root, a fan opens outward and no wider than a half turn.
        if (n.depth > 0 && a1 - a0 > Math.PI) { a0 = a - Math.PI / 2; a1 = a + Math.PI / 2 }
        let from = a0
        for (const k of n.kids) {
          const span = (a1 - a0) * k.leaves / n.leaves
          place(k, from, from + span)
          from += span
        }
      }
      place(g.root, -Math.PI, Math.PI)
    })
    // Bubbles joined to nothing: rows along the bottom, filling upward.
    const pitch = R * 2 + 0.04, perRow = Math.max(1, Math.floor(availW / pitch))
    singles.forEach((g, i) => {
      const row = Math.floor(i / perRow), inRow = Math.min(perRow, singles.length - row * perRow), col = i % perRow
      const y = trees.length ? y1 - R - 0.02 - row * pitch : (y0 + y1) / 2 + (row - (Math.ceil(singles.length / perRow) - 1) / 2) * pitch
      send(g.root.b, (x0 * A + availW / 2 + (col - (inRow - 1) / 2) * pitch) / A, y)
    })
    this.onEvent?.('tidy', { bubbles: all.length, groups: trees.length, loose: singles.length })
    return true
  }

  /** Picking a bubble up draws what is joined to it back within reach: organising may have left them far apart. */
  private gather(b: Bubble) {
    const todo = [b], seen = new Set([b.id])
    while (todo.length) {
      const k = todo.pop()!
      k.loose = false
      for (const o of this.bubbles) {
        if (seen.has(o.id) || o.leaving) continue
        const joined = o.parent === k.id || k.parent === o.id || o.knot?.includes(k.id) || k.knot?.includes(o.id)
          || this.links.some(l => l.includes(k.id) && l.includes(o.id))
        if (joined) { seen.add(o.id); todo.push(o) }
      }
    }
  }

  /** Grow a reworked version of `b` as a branch beside it. */
  private variant(b: Bubble, how: Rework, t: number) {
    const context = this.zoneContext(b)
    const v = this.sprout(b, t)
    v.full = `${{ further: 'Taken further', smaller: 'Simplest version', opposite: 'The opposite', combine: '' }[how]}: ${b.text}`
    this.ask(v, how, b.text, undefined, context)
  }

  private zoneAt(b: Bubble) {
    const { x0, x1, y0, y1 } = this.bounds
    const x = (b.x - x0) / (x1 - x0), y = (b.y - y0) / (y1 - y0)
    return this.zoneRects.find(z => x >= z.x0 && x < z.x1 && y >= z.y0 && y < z.y1)
  }

  private contextBubbles(b: Bubble) {
    const zone = this.zoneAt(b)
    return this.bubbles.filter(k => !k.pending && !k.leaving && (!this.modes.zones || k === b || !!zone && this.zoneAt(k)?.id === zone.id))
  }

  private zoneContext(b: Bubble): { zone?: string; board?: string[] } {
    return this.modes.zones
      ? { zone: this.zoneAt(b)?.name ?? 'Outside zones', board: this.contextBubbles(b).filter(k => k !== b).map(k => k.text) }
      : {}
  }

  private ask(b: Bubble, how: Rework, idea: string, other?: string, context = this.zoneContext(b)) {
    if (this.onRequest) {
      b.pending = true
      this.onRequest({ kind: 'rework', bubbleId: b.id, how, idea, other, ...context })
    } else this.setText(b.id, fallbackText(how, idea, other))
  }

  private applyHolds(hands: Hand[]) {
    const byId = new Map(hands.map(h => [h.id, h]))
    for (const b of this.bubbles) {
      const held = b.holders.map(id => byId.get(id)).filter((h): h is Hand => !!h)
      if (held.length === 0) continue
      const [a, second] = held
      const st = this.hands.get(a.id)!
      // It stays with the hand that grabbed it first; a second hand only sets the size.
      b.x = this.at(a).x + st.offX
      b.y = this.at(a).y + st.offY
      if (second) {
        const p1 = this.at(a), p2 = this.at(second)
        const dist = this.dist(p1.x, p1.y, p2.x, p2.y)
        let s = this.stretch.get(b.id)
        if (!s) { s = { dist, scale: b.scale, sign: Math.sign(a.x - second.x) || 1 }; this.stretch.set(b.id, s) }
        // By how far the hands moved, not by the ratio: hands that start close together would otherwise send it to the limit.
        b.scale = Math.min(2.6, Math.max(0.5, s.scale + (dist - s.dist) * STRETCH_PER_HEIGHT))
        b.opened = b.scale >= OPEN_AT
        b.mergeInto = undefined
        if (this.modes.workbench) {
          const crossed = Math.sign(a.x - second.x) === -s.sign && Math.abs(a.x - second.x) > 0.04
          const ratio = b.scale / s.scale
          b.hint = crossed ? 'opposite' : ratio >= 1.4 ? 'further' : ratio <= 0.72 ? 'smaller' : undefined
        }
      } else {
        const under = this.bubbles.find(o => o !== b && !o.leaving && !o.pending && o.holders.length === 0
          && this.dist(b.x, b.y, o.x, o.y) < (R * b.scale + R * o.scale) * MERGE_OVERLAP)
        b.mergeInto = b.pending ? undefined : under?.id
      }
    }
  }

  private physics(dt: number) {
    const A = this.aspect
    const free = (b: Bubble) => !b.leaving && b.holders.length === 0
    for (const b of this.bubbles) {
      if (b.leaving === 'burn') continue // burns where it stands
      if (b.leaving) {
        if (b.leaving === 'bin') b.vy += 4 * dt
        b.x += b.vx * dt
        b.y += b.vy * dt
      } else if (free(b)) {
        b.x += b.vx * dt
        b.y += b.vy * dt
        const k = Math.exp(-3 * dt)
        b.vx *= k
        b.vy *= k
      }
    }
    // After the board is organised, bubbles glide to their places (branches follow their parents).
    for (const b of this.bubbles) {
      if (!b.goal || !free(b)) continue
      const k = Math.min(1, dt * 4)
      b.x += (b.goal.x - b.x) * k
      b.y += (b.goal.y - b.y) * k
      if (this.dist(b.x, b.y, b.goal.x, b.goal.y) < 0.01) b.goal = undefined
    }
    // `b` stays within `slack` of `p`; `lead` is how much of the pull `b` takes when both are free.
    const tether = (b: Bubble, p: Bubble, slack: number, lead: number, gap = LINK_GAP) => {
      if (b.leaving || p.leaving || b.goal || p.goal || b.loose || p.loose) return
      const d = this.dist(b.x, b.y, p.x, p.y)
      const limit = (R * b.scale + R * p.scale + gap) * slack
      if (d <= limit || d === 0) return
      const pull = (d - limit) * Math.min(1, dt * 8)
      const nx = (p.x - b.x) * A / d, ny = (p.y - b.y) / d
      const share = !free(b) ? 0 : !free(p) ? 1 : lead
      if (free(b)) { b.x += nx * pull * share / A; b.y += ny * pull * share }
      if (free(p)) { p.x -= nx * pull * (1 - share) / A; p.y -= ny * pull * (1 - share) }
    }
    // Branches stay within reach of what they grew from; connected ideas stay loosely together.
    for (const b of this.bubbles) {
      const p = this.byId(b.parent)
      if (p) tether(b, p, 1.25, 0.7, BRANCH_GAP)
    }
    for (const [a, b] of this.links) {
      const p = this.byId(a), q = this.byId(b)
      if (!p || !q) continue
      tether(p, q, 2.2, 0.5)
      // ...but not so close that the knot between them is covered.
      const d = this.dist(p.x, p.y, q.x, q.y)
      const short = R * KNOT_ROOM - (d - R * p.scale - R * q.scale)
      if (short <= 0 || d === 0 || !free(p) || !free(q) || p.goal || q.goal) continue
      const nx = (q.x - p.x) * A / d, ny = (q.y - p.y) / d
      const push = short * 0.5 * Math.min(1, dt * 6)
      p.x -= nx * push / A; p.y -= ny * push
      q.x += nx * push / A; q.y += ny * push
    }
    // What grew from a connection stays by its knot, and is on its own once the connection has gone.
    for (const b of this.bubbles) {
      if (!b.knot) continue
      const p = this.byId(b.knot[0]), q = this.byId(b.knot[1])
      if (!p || !q || p.leaving || q.leaving || !this.links.some(l => l.includes(p.id) && l.includes(q.id))) { b.knot = undefined; continue }
      if (b.leaving || b.goal || b.loose || !free(b)) continue
      const k = this.knot(p, q)
      const d = this.dist(b.x, b.y, k.x, k.y)
      const limit = (R * b.scale + R * KNOT_CLEAR + LINK_GAP) * 1.4
      if (d <= limit) continue
      const pull = (d - limit) * Math.min(1, dt * 8)
      b.x += (k.x - b.x) * pull / d; b.y += (k.y - b.y) * pull / d
    }
    // Bubbles lying on the board push each other apart. A held one passes over the rest, so it can be dropped on one.
    for (let i = 0; i < this.bubbles.length; i++) {
      for (let j = i + 1; j < this.bubbles.length; j++) {
        const a = this.bubbles[i], b = this.bubbles[j]
        if (!free(a) || !free(b)) continue
        const d = this.dist(a.x, a.y, b.x, b.y)
        const min = R * a.scale + R * b.scale + PAD
        if (d >= min) continue
        const nx = d ? (b.x - a.x) * A / d : 1, ny = d ? (b.y - a.y) / d : 0
        const push = (min - d) * 0.5 * Math.min(1, dt * 12)
        a.x -= nx * push / A; a.y -= ny * push
        b.x += nx * push / A; b.y += ny * push
      }
    }
    for (const b of this.bubbles) {
      if (!free(b)) continue
      // The walls are the edge of reach, and a bubble's centre must stay inside them (its rim may
      // poke out, which keeps as much of the screen in use as possible).
      const { x0, y0, x1, y1 } = this.bounds
      const r = R * b.scale
      const left = Math.max(x0, Math.min(0.5, r / A)), right = Math.min(x1, 1 - Math.min(0.5, r / A))
      const top = Math.max(y0, Math.min(0.5, r)), bottom = Math.min(y1, 1 - Math.min(0.5, r))
      if (b.x < left) { b.x += (left - b.x) * Math.min(1, dt * 10 + 0.2); b.vx = Math.abs(b.vx) * 0.4 }
      if (b.x > right) { b.x += (right - b.x) * Math.min(1, dt * 10 + 0.2); b.vx = -Math.abs(b.vx) * 0.4 }
      if (b.y < top) { b.y += (top - b.y) * Math.min(1, dt * 10 + 0.2); b.vy = Math.abs(b.vy) * 0.4 }
      if (b.y > bottom) { b.y += (bottom - b.y) * Math.min(1, dt * 10 + 0.2); b.vy = -Math.abs(b.vy) * 0.4 }
    }
    const now = this.lastT ?? 0
    this.bubbles = this.bubbles.filter(b => b.x > -0.3 && b.x < 1.3 && b.y > -0.4 && b.y < 1.4 && !(b.leaving === 'burn' && now - (b.leftAt ?? now) >= BURN_OUT_MS))
  }

}
