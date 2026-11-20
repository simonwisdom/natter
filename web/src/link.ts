/** WebSocket to the local server, reconnecting quietly. Protocol in server/src/natter_server/app.py. */

export type ServerMessage =
  | { type: 'status'; stt: 'loading' | 'ready' | 'failed'; llm: 'ready' | 'claude_code' | 'no_api_key' | 'ollama' | 'ollama_loading' | 'ollama_failed' }
  /** A Body Lab final that was only filler ("well", "mm-hmm") has empty text and the words in `skipped`. */
  | { type: 'partial' | 'final'; turnId: string; text: string; skipped?: string; /** On a final: how long the sound was, and how loud (about -90 dBFS for a silent microphone, -30 for speech). */ audio_s?: number; audio_dbfs?: number }
  | { type: 'result'; turnId: string; text: string; result: ResolverResult; tier: string; timings: Record<string, number> }
  /** Body Lab: words for a bubble. `id` is the rework id, or the turnId of a spoken idea. */
  | { type: 'idea'; id: string; text?: string; emoji?: string; error?: string; ms?: number }
  /** Body Lab: Claude's own ideas for the bubbles asked for under `id`. */
  | { type: 'ideas'; id: string; ideas?: { text: string; emoji: string }[]; /** The spoken angle as Claude understood it, if there was one. */ angle?: string; error?: string; ms?: number }
  /** Body Lab: how to organise the board; `id` is the turnId of the spoken request. The rest is a Structure. */
  | { type: 'structure'; id: string; kind?: string; error?: string; ms?: number; [key: string]: unknown }

export type ResolverResult =
  | { kind: 'actions'; calls: { name: string; input: Record<string, unknown> }[]; sceneVersion: number; summary?: string }
  | { kind: 'clarify'; question: string; candidates?: string[] }
  | { kind: 'none'; reason: 'cancelled' | 'not_a_command' | 'no_matching_action'; explanation?: string }
  | { kind: 'error'; reason: string; problems?: string[] }

export class Link {
  private ws?: WebSocket
  private url: string
  connected = false
  onMessage?: (msg: ServerMessage) => void
  onConnection?: (connected: boolean) => void

  constructor(url: string) {
    this.url = url
    this.connect()
  }

  private connect() {
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => { this.connected = true; this.onConnection?.(true) }
    ws.onmessage = e => this.onMessage?.(JSON.parse(e.data))
    ws.onclose = () => {
      if (this.connected) this.onConnection?.(false)
      this.connected = false
      setTimeout(() => this.connect(), 1000)
    }
    this.ws = ws
  }

  send(msg: object): boolean {
    if (!this.connected || this.ws!.readyState !== WebSocket.OPEN) return false
    this.ws!.send(JSON.stringify(msg))
    return true
  }

  sendAudio(pcm: Float32Array<ArrayBuffer>) {
    if (this.connected) this.ws!.send(pcm)
  }
}
