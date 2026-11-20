/**
 * The log panel (L, or ?log): the session log as it happens, in plain words, for showing an audience
 * what the lab heard, what it did and how long Claude took. It reads the same events the session log
 * writes; hand readings, moves and other frame-by-frame detail are left out.
 */

type Data = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const quote = (v: unknown) => `“${str(v)}”`
const secs = (ms: unknown) => (typeof ms === 'number' ? ` · ${(ms / 1000).toFixed(1)} s` : '')
/** Who wrote the words: Claude, unless the local fallback model answered. */
const writer = (d: Data) => (str(d.backend) === 'ollama' ? 'Local model' : 'Claude')

/** One event as a line for the panel, or nothing if it is not worth an audience's attention. */
export function feedLine(type: string, d: Data): string | undefined {
  switch (type) {
    case 'ideaStart': return d.branchFrom ? '☝️ Listening for a branch' : '✊ Listening for an idea'
    case 'ideaAbandoned': return d.why === 'connected instead' ? undefined : `✋ Idea dropped (${str(d.why) || 'hand lost'})`
    case 'structureStart': return '🙌 Listening: how to organise the board'
    case 'final': {
      const text = str(d.text).trim()
      if (text) return `🎙️ Heard ${quote(text)}`
      return d.skipped ? `🎙️ Skipped ${quote(d.skipped)}` : '🎙️ Heard nothing'
    }
    case 'idea': return str(d.text) ? `✨ ${writer(d)} → ${str(d.emoji)} ${str(d.text)}${secs(d.ms)}`.replace('→  ', '→ ') : undefined
    case 'ideas': {
      const ideas = Array.isArray(d.ideas) ? d.ideas.map(i => str((i as Data)?.text)).filter(Boolean) : []
      return ideas.length ? `✨ ${writer(d)} → ${ideas.join(' / ')}${secs(d.ms)}` : undefined
    }
    case 'structure': {
      if (d.kind === 'zones' && Array.isArray(d.zones)) return `✨ Claude → zones: ${d.zones.join(', ')}`
      if (d.kind === 'axes') return '✨ Claude → two axes'
      return d.kind === 'clear' ? '✨ Claude → structure cleared' : undefined
    }
    case 'merge': return `✊ Merged ${quote(d.text)} into ${quote(d.into)}`
    case 'connect': return `☝️ Connected ${quote(d.a)} and ${quote(d.b)}`
    case 'disconnect': return `☝️ Disconnected ${quote(d.a)} and ${quote(d.b)}`
    case 'ask': return `✌️ Asked about ${quote(d.text)}${d.other ? ` and ${quote(d.other)}` : ''}`
    case 'bin': return `${d.mode === 'delete' ? '🔥 Burned' : '👎 Binned'} ${quote(d.text)}`
    case 'star': return `👍 ${d.starred ? 'Starred' : 'Unstarred'} ${quote(d.text)}`
    case 'tidy': return `✨ Tidied ${typeof d.bubbles === 'number' ? d.bubbles : 'the'} bubbles`
    case 'renameZone': return `🎙️ Zone named ${quote(d.name)}`
    case 'deleteMode': return d.on ? '🔥 Delete mode on' : 'Delete mode off'
    default: return undefined
  }
}

export interface FeedRow { at: string; text: string }

/** The last few lines, oldest first, each with the session time it happened at. */
export class Feed {
  rows: FeedRow[] = []
  /** Counts every line added, so whoever draws the panel can tell when it has changed. */
  version = 0
  private keep: number
  constructor(keep = 6) { this.keep = keep }

  add(type: string, data: Data, ms: number) {
    const text = feedLine(type, data)
    if (!text) return
    const s = Math.max(0, Math.floor(ms / 1000))
    this.rows.push({ at: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, text })
    if (this.rows.length > this.keep) this.rows.shift()
    this.version++
  }
}
