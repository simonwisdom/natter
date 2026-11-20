/**
 * Stage mode: what is happening on the board, in a few words an audience can read from the back of a room.
 * While a hand is in the middle of something, the words sit small beside that hand, where the person
 * using it is looking. Once it is done and needs nothing more from them, the same words go up in one
 * large band at the top (main.ts draws both).
 */
import type { Hand } from './body'
import type { Play } from './play'

export type StageKind = 'organise' | 'ask' | 'idea' | 'branch' | 'connect' | 'move' | 'merge' | 'resize' | 'thinking' | 'delete' | 'notice'
export interface StageLine { kind: StageKind; what: string; heard?: string; thinking?: boolean }

type Board = Pick<Play, 'asks' | 'ideas' | 'bubbles' | 'modes' | 'deleting' | 'byId'>

export interface StageWords {
  /** The board being organised by voice: what was heard, and whether the words have gone off to be acted on. */
  organising?: { heard: string; thinking: boolean }
  /** What has been heard so far from the hand that is speaking. */
  captions: Map<number, string>
  /** The hand whose words are being listened to now. */
  listening?: number
}

/** What one hand is in the middle of, if anything. */
export function handLine(play: Board, h: Pick<Hand, 'id' | 'resting'>, words: StageWords): StageLine | undefined {
  if (h.resting) return
  const heard = words.captions.get(h.id) ? `“${words.captions.get(h.id)}”` : words.listening === h.id ? 'listening…' : ''
  const ask = play.asks.get(h.id)
  // On a hub, the ask is about it and everything connected to it.
  if (ask) return { kind: 'ask', what: ask.linked?.length ? `✌️ Ask for ideas from all ${ask.linked.length + 1}` : '✌️ Ask for ideas', heard }
  const idea = play.ideas.get(h.id)
  if (idea) {
    const parent = play.byId(idea.parent), onto = play.byId(idea.over)
    if (!parent) return { kind: 'idea', what: '💡 New idea', heard }
    return onto ? { kind: 'connect', what: `🔗 Connect to “${onto.text}”`, heard } : { kind: 'branch', what: `🌱 Branch from “${parent.text}”`, heard }
  }
  const held = play.bubbles.find(b => b.holders.includes(h.id))
  if (!held) return
  const into = play.byId(held.mergeInto)
  if (held.holders.length > 1) return { kind: 'resize', what: play.modes.workbench ? '✊✊ Rework' : '✊✊ Resize' }
  return into ? { kind: 'merge', what: `✊ Merge into “${into.text}”` } : { kind: 'move', what: '✊ Move' }
}

/** What the board as a whole is doing, whichever hand started it. */
export function boardLine(play: Board, words: StageWords): StageLine | undefined {
  const { organising } = words
  if (organising) return organising.thinking
    ? { kind: 'organise', what: '✨ Organising the board', heard: organising.heard ? `“${organising.heard}”` : '', thinking: true }
    : { kind: 'organise', what: '🙌 Organise the board', heard: organising.heard ? `“${organising.heard}”` : 'listening…' }
  if (play.bubbles.some(b => b.pending)) return { kind: 'thinking', what: '✨ Thinking', thinking: true }
  if (play.deleting) return { kind: 'delete', what: '🔥 Delete mode' }
}

/** How long a finished action stays in the band. */
export const BAND_MS = 2500

/** The band at the top: an action goes up once its hand has finished it. */
export class Band {
  private live = new Map<number, { line: StageLine; bubbles: number }>()
  private done?: { line: StageLine; until: number }

  /** A short message ("Didn’t catch that") shown in the band for a moment, instead of over the middle of the board. */
  notice(what: string, t: number) {
    this.done = { line: { kind: 'notice', what }, until: t + BAND_MS }
  }

  /** `hands` is what each hand is in the middle of now; `bubbles` is how many bubbles are on the board. */
  update(hands: Map<number, StageLine>, board: StageLine | undefined, t: number, bubbles: number): StageLine | undefined {
    for (const [id, was] of this.live) {
      if (hands.has(id)) continue
      this.live.delete(id)
      const { kind } = was.line
      // Moving and resizing need no announcement, and a new idea or branch counts only if it was placed (not cancelled).
      const happened = kind === 'merge' || kind === 'connect' || kind === 'ask' || ((kind === 'idea' || kind === 'branch') && bubbles > was.bubbles)
      // It has happened now, so the band says so in the past tense.
      const what = was.line.what.replace('Merge into', 'Merged into').replace('Connect to', 'Connected to')
      if (happened) this.done = { line: { ...was.line, what, heard: was.line.heard === 'listening…' ? '' : was.line.heard }, until: t + BAND_MS }
    }
    for (const [id, line] of hands) this.live.set(id, { line, bubbles })
    // A sign still held has its new bubbles out already, waiting; nothing is being thought about until it is lowered.
    if (board?.kind === 'thinking' && [...hands.values()].some(l => l.kind === 'ask')) board = undefined
    if (board?.kind === 'organise') return board
    if (this.done && t < this.done.until) return { ...this.done.line, thinking: !!board?.thinking }
    this.done = undefined
    return board
  }
}
